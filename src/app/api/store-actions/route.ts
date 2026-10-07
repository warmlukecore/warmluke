import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { runAction } from "@/lib/run-action";
import { proposeStoreAction, type Proposal } from "@/lib/store-action-propose";
import type { StoreBrief } from "@/lib/store-read";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * POST /api/store-actions — body: { actionId, do: "run" | "dismiss" | "undo" },
 * or { do: "ask", projectId, action, targets, params } from a list's screen
 *
 * The merchant's yes, and the change going out.
 *
 * Approving and running are one call on purpose. They are one act to
 * the person doing it, and splitting them would leave a row somebody
 * had agreed to and nothing had picked up — approved, waiting, with
 * no button anywhere that would move it on.
 *
 * Nothing here decides whether it is allowed. abo_action_approve
 * refuses a token carrying a client_id, refuses anything not
 * pending, and refuses a project that is not theirs; the claim
 * inside runAction refuses a second run. So a connected assistant
 * calling this route with a merchant's session gets the same no it
 * would get anywhere else — the rule lives in one place, and this is
 * not that place.
 *
 * Callers: src/components/ChatPanel.tsx (run, dismiss), src/components/AppShell.tsx (ask, undo).
 */

const BRIEF = "id, project_id, shop_domain, timezone, currency, last_synced_at";

/**
 * Asked, then sent now when the database takes it as the owner's yes (the
 * owner's own, fresh, of a kind they turned on for that store); otherwise
 * it waits in the bell, the owner's yes being the only way out.
 */
async function askedThenSent(client: SupabaseClient, asked: Proposal) {
  if (!asked.ok) return NextResponse.json(asked.answer, { status: 400 });
  const { data: now } = await client.rpc("abo_action_send_now", { p_action: asked.id });
  if (!(now as { approved?: boolean } | null)?.approved) {
    return NextResponse.json({ status: "waiting", actionId: asked.id, summary: asked.summary });
  }
  const run = await runAction(client, asked.id);
  return NextResponse.json({ ...run, actionId: asked.id, summary: asked.summary });
}
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { client } = auth;

    const body = (await req.json().catch(() => null)) as {
      actionId?: string;
      do?: string;
      projectId?: string;
      action?: string;
      targets?: unknown;
      params?: unknown;
    } | null;
    const actionId = body?.actionId?.trim();
    const what = body?.do ?? "run";

    // Asked from a list's screen (0195): ticked rows, one change. Asked as
    // Luke and their own AI ask, through the same gates; then, when it is
    // the owner's own, of a kind they turned on for that store, the
    // database takes it as their yes and it goes out now. Otherwise it
    // waits in the bell, the owner's yes being the only way out.
    if (what === "ask") {
      const projectId = body?.projectId?.trim();
      if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
      const { data: store } = await client
        .from("stores")
        .select(BRIEF)
        .eq("project_id", projectId)
        .eq("status", "connected")
        .limit(1)
        .maybeSingle();
      if (!store) return NextResponse.json({ error: "There is no connected store to change." }, { status: 400 });
      const asked = await proposeStoreAction(client, store as StoreBrief, {
        action: body?.action,
        targets: body?.targets,
        params: body?.params,
      });
      return askedThenSent(client, asked);
    }

    if (!actionId) {
      return NextResponse.json({ error: "actionId is required" }, { status: 400 });
    }

    // Put back (7 Oct): the opposite of a change that went through, on the
    // lines it really changed, asked for as any change is, through the same
    // gates. Built here from the row, never from what the caller says it
    // was. A stock count goes back only while Shopify's is still the one
    // this change left; an undo of an undo is a redo.
    if (what === "undo") {
      const { data: was } = await client.from("store_actions").select("store_id").eq("id", actionId).maybeSingle();
      if (!was) return NextResponse.json({ error: "That change is not one you can see." }, { status: 404 });
      const { data: store } = await client
        .from("stores")
        .select(BRIEF)
        .eq("id", was.store_id as string)
        .eq("status", "connected")
        .maybeSingle();
      if (!store) return NextResponse.json({ error: "That store is not connected any more." }, { status: 400 });
      return askedThenSent(client, await proposeStoreAction(client, store as StoreBrief, { undo_of: actionId }));
    }
    if (what !== "run" && what !== "dismiss") {
      return NextResponse.json({ error: `There is no "${what}" to do here.` }, { status: 400 });
    }

    if (what === "dismiss") {
      const { data, error } = await client.rpc("abo_action_dismiss", { p_action: actionId });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      // False means it was not theirs to turn down, or it had already
      // moved on. Neither is an error worth a red box; the panel
      // reloads and shows what is really there.
      return NextResponse.json({ dismissed: data === true });
    }

    const { data: nod, error: nodError } = await client.rpc("abo_action_approve", {
      p_action: actionId,
    });
    if (nodError) return NextResponse.json({ error: nodError.message }, { status: 400 });
    const approval = nod as { approved?: boolean; reason?: string } | null;
    if (!approval?.approved) {
      return NextResponse.json(
        {
          error: approval?.reason ?? "That change is not waiting for a yes.",
          // Said out loud because the commonest way to see this is a
          // second tab, or a second tap, on something already gone.
          note: "Nothing was sent to the shop.",
        },
        { status: 409 }
      );
    }

    const run = await runAction(client, actionId);
    return NextResponse.json(run);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
