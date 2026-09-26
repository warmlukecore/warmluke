import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "@/lib/supabase-server";
import { applyPlans, logClientBuild } from "@/lib/apply";
import { describePlan } from "@/lib/describe";
import { undoableFrom } from "@/lib/undo";
import type { AssistantPlan, ModuleRow, NextStep } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/apply — body: { projectId, plans, requestId?, thread? }
 *
 * The app's entrance to the builder. The work itself lives in
 * lib/apply, which the MCP approval path uses as well, so a change to
 * how plans are applied cannot land in one place and miss the other.
 *
 * requestId is what the panel passes when the owner taps Build on a
 * card their assistant raised. Without it that path claimed nothing:
 * two tabs, or a second tap before the first rerendered, or the app
 * racing the connected client, all ran the same plans at once — the
 * status only moved to built after the writes were already done. The
 * claim is a compare-and-set, so the second caller is told it is
 * already being built rather than building it again.
 *
 * thread is what the panel passes when the owner taps Build on a card
 * in the chat: the conversation, the design message the card belongs
 * to, and which of its plans were sent. The build is then written into
 * that thread here, as it starts and as it ends, rather than by the
 * browser once it hears back. The browser only heard back if it was
 * still open: closing the app mid-build left no receipt, and the card
 * came back offering to build again what was already built.
 */
export async function POST(req: Request) {
  try {
    // The body before anything that waits: a browser that goes away
    // takes its unread body with it, and the build it asked for failed
    // to start. Read at once, the build carries on without it.
    const { projectId, plans, requestId, thread } = (await req.json()) as {
      projectId?: string;
      plans?: AssistantPlan[];
      requestId?: string;
      thread?: Thread;
    };
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;
    if (!projectId || !Array.isArray(plans) || plans.length === 0) {
      return NextResponse.json({ error: "projectId and plans are required" }, { status: 400 });
    }

    // Verify project ownership via RLS (query returns nothing if not owner).
    const { data: proj } = await client.from("projects").select("id").eq("id", projectId).limit(1);
    if (!proj?.[0]) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    if (requestId) {
      const { data: claim, error: claimErr } = await client.rpc("abo_build", {
        p_project: projectId,
        p_request: requestId,
        p_op: "request_claim",
        p_payload: {},
      });
      if (claimErr) {
        return NextResponse.json({ error: claimErr.message }, { status: 400 });
      }
      if (Number((claim as { count?: number } | null)?.count ?? 0) === 0) {
        // Somebody got here first. Not an error to the person who
        // tapped second — the thing they asked for is happening.
        return NextResponse.json(
          { applied: false, already: true, error: "This is already being built." },
          { status: 409 }
        );
      }
    }

    const book = !requestId && thread?.conversationId ? await openBook(client, projectId, thread, plans.length) : null;

    const { applied, errors, failedAt } = await applyPlans(client, projectId, plans, requestId ?? null);

    if (book) {
      if (applied.length === 0) {
        await book.close("Nothing was built — the design did not fit.", {
          status: "refused",
          errors,
          ...(failedAt !== undefined ? { failedAt } : {}),
        });
      } else {
        const { data: mods } = await client.from("modules").select("*").eq("project_id", projectId);
        const titles = plans
          .slice(0, applied.length)
          .map((p) => describePlan(p, (mods ?? []) as ModuleRow[]).title)
          .filter(Boolean);
        // What the design offered to do next, only when all of it landed.
        const offer = errors.length === 0 ? nextSteps(thread?.next) : [];
        const shown = titles.slice(0, 3).join(" · ");
        const rest = titles.length - 3;
        const undo = undoableFrom(applied);
        await book.close(
          `${shown}${rest > 0 ? ` · and ${rest} more` : ""}.${offer.length ? "" : " Tell me what to change next."}`,
          { status: "built", ...(undo.length ? { undo } : {}), ...(offer.length ? { next: offer } : {}) }
        );
      }
    }
    const recorded = book ? { recorded: book.id } : {};

    if (applied.length === 0) {
      if (requestId) {
        // Put it back for whoever wants to try again.
        await client.rpc("abo_build", {
          p_project: projectId,
          p_request: requestId,
          p_op: "request_release",
          p_payload: {},
        });
      }
      return NextResponse.json({ applied: false, errors, failedAt, ...recorded }, { status: 422 });
    }

    if (requestId) {
      // The outcome decides the status, and it believes the errors.
      await client.rpc("abo_build", {
        p_project: projectId,
        p_request: requestId,
        p_op: "request_built",
        p_payload: { applied, errors },
      });

      // A request row exists only when this came from the merchant's
      // own assistant, so this is the one path where the thread needs
      // to say what was asked — the browser knows the outcome but the
      // question was put somewhere else entirely.
      const { data: askedRow } = await client
        .from("build_requests")
        .select("request, client_id")
        .eq("id", requestId)
        .maybeSingle();
      const asked = (askedRow as { request?: string; client_id?: string | null } | null) ?? null;
      if (asked?.client_id && asked.request) {
        const { data: mods } = await client.from("modules").select("*").eq("project_id", projectId);
        const titles = (plans as AssistantPlan[])
          .slice(0, applied.length)
          .map((p) => describePlan(p, (mods ?? []) as ModuleRow[]).title)
          .filter(Boolean);
        const shown = titles.slice(0, 3).join(" · ");
        const rest = titles.length - 3;
        await logClientBuild(
          client,
          projectId,
          asked.request,
          `✅ ${shown}${rest > 0 ? ` · and ${rest} more` : ""}${
            errors.length ? " — the rest stopped on an error." : "."
          }`,
          applied
        );
      }
    }

    // Plans run in order and stop at the first failure, so a partial run
    // leaves the rest unbuilt. Reporting only the successes would hand
    // back a half-built feature with no sign that anything was missing.
    if (errors.length > 0) {
      return NextResponse.json({
        applied: true,
        partial: true,
        count: applied.length,
        remaining: Math.min(plans.length, 6) - applied.length,
        results: applied,
        errors,
        ...recorded,
      });
    }

    return NextResponse.json({ applied: true, count: applied.length, results: applied, ...recorded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("apply failed:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Where a build from the chat is written: its thread, its card, the plans sent. */
type Thread = { conversationId?: string; designId?: string | null; sent?: number[]; next?: NextStep[] };

/** Only well-formed suggestions, and a few: they are shown as they are. */
function nextSteps(next: unknown): NextStep[] {
  return (Array.isArray(next) ? next : [])
    .filter((n) => typeof n?.label === "string" && typeof n?.prompt === "string")
    .slice(0, 4)
    .map((n) => ({ label: n.label.slice(0, 80), prompt: n.prompt.slice(0, 500) }));
}

/** The thread moved, so the panels watching it read it again. */
const touch = (client: SupabaseClient, conversationId: string) =>
  client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

/**
 * A build written into its thread as it starts, and the same message
 * rewritten as it ends: a panel that loads the thread mid-build finds
 * it building, and one that loads it afterwards finds what came of it.
 * A thread of another project is not written to; the build still runs.
 */
async function openBook(client: SupabaseClient, projectId: string, thread: Thread, count: number) {
  const conversationId = thread.conversationId!;
  const { data: mine } = await client
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!mine) return null;
  const base = {
    type: "build",
    design: typeof thread.designId === "string" ? thread.designId : null,
    sent: Array.isArray(thread.sent)
      ? thread.sent.filter((n) => Number.isInteger(n))
      : Array.from({ length: count }, (_, i) => i),
    started_at: new Date().toISOString(),
  };
  const text = `Building ${count} change${count === 1 ? "" : "s"}…`;
  const { data, error } = await client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role: "assistant",
      content: text,
      payload: { ...base, status: "building", message: text },
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("could not record the build starting:", error?.message);
    return null;
  }
  await touch(client, conversationId);
  return {
    id: data.id as string,
    async close(message: string, outcome: Record<string, unknown>) {
      const { error: wrote } = await client
        .from("messages")
        .update({ content: message, payload: { ...base, ...outcome, message, finished_at: new Date().toISOString() } })
        .eq("id", data.id);
      if (wrote) console.error("could not record how the build ended:", wrote.message);
      await touch(client, conversationId);
    },
  };
}
