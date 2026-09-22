import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { runAction } from "@/lib/run-action";

export const runtime = "nodejs";

/**
 * POST /api/store-actions — body: { actionId, do: "run" | "dismiss" }
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
 * Callers: src/components/ChatPanel.tsx.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { client } = auth;

    const body = (await req.json().catch(() => null)) as {
      actionId?: string;
      do?: string;
    } | null;
    const actionId = body?.actionId?.trim();
    const what = body?.do ?? "run";
    if (!actionId) {
      return NextResponse.json({ error: "actionId is required" }, { status: 400 });
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
