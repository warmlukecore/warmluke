// A turn's before and after: what it reads, and everything once the
// model is done — the answer's line filled, the receipt, the charge kept
// or given back, the trace, what was learned, the thread's name.
//
// Two callers, one code: the chat route, which runs a turn inside one
// request, and the durable turn (workflows/luke-turn.ts), which runs it
// in legs past any one function's time. Neither holds anything the other
// does not: all a turn needs travels as a TurnJob, plain data.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatTurn } from "@/lib/ai";
import { MAX_REPAIR_ATTEMPTS, answeredTurns, type TurnResult } from "@/lib/engine";
import { noteJudgement } from "@/lib/judge";
import { learn } from "@/lib/memory";
import { traceTurn } from "@/lib/trace";
import { finishClientTurn, settleClientLine } from "@/lib/client-turn";
import { TITLE_MAX } from "@/lib/types";
import type {
  AssistantReply,
  FeatureSchema,
  MessageRow,
  ModuleRow,
  ProjectRow,
  TurnEvent,
  TurnUsage,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

type SchemaJsonWithFeatures = UiSchema & { features?: FeatureSchema | null };

/** How many past turns to replay. Enough for a full discovery loop. */
export const HISTORY_LIMIT = 30;

/** One turn, as the durable turn carries it between legs: ids and words, nothing live. */
export type TurnJob = {
  userId: string;
  projectId: string;
  moduleId: string | null;
  conversationId: string;
  askedId: string;
  answerId: string;
  message: string;
  askedModel: string | null;
  askedAt: number;
  isNewConversation: boolean;
  /**
   * Asked by the merchant's own AI over MCP (propose_change), in a thread
   * of its own: filled through abo_client_settle, since a client's token
   * may not write messages, and ended as a request (lib/client-turn).
   */
  client?: { origin: string };
};

/** Life a token needs left for a durable turn: several legs, with room. */
export const TOKEN_LEFT_MS = 15 * 60_000;

/** When a verified bearer token lapses (epoch ms), or 0 when it cannot be read. */
export function lapsesAt(token: string): number {
  try {
    return Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** What a turn reads about the app and the thread before the model runs. */
export type TurnContext = {
  proj: ProjectRow;
  moduleList: ModuleRow[];
  currentSchema: UiSchema | null;
  currentFeatures: FeatureSchema | null;
  history: ChatTurn[];
  blueprintShown: boolean;
};

/**
 * The app's sections, the open section's schema, and the thread so far.
 * Read the same way before the question is kept (the chat route) and
 * after (a durable leg): the question and the line waiting for its
 * answer are not yet answered, so they are not history either way.
 */
export async function turnContext(
  client: SupabaseClient,
  proj: ProjectRow,
  {
    projectId,
    moduleId,
    conversationId,
    before,
  }: {
    projectId: string;
    moduleId: string | null;
    conversationId: string | null;
    /** Only what was said before this (the question's own time): the same thread whenever it is read. */
    before?: string;
  }
): Promise<TurnContext> {
  const convId = conversationId;
  const { data: modules, error: modErr } = await client
    .from("modules")
    .select("*")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true });
  if (modErr) throw new Error(modErr.message);

  const moduleList = (modules ?? []) as ModuleRow[];

  let currentSchema: UiSchema | null = null;
  let currentFeatures: FeatureSchema | null = null;
  if (moduleId) {
    const { data: schemaRow } = await client
      .from("ui_schemas")
      .select("*")
      .eq("module_id", moduleId)
      .order("version", { ascending: false })
      .limit(1);
    const row = schemaRow?.[0] as UiSchemaRow | undefined;
    if (row) {
      const sj = row.schema_json as SchemaJsonWithFeatures;
      currentSchema = { columns: sj.columns };
      currentFeatures = sj.features ?? null;
    }
  }

  const { data: historyRows, error: histErr } = convId
    ? await client
        .from("messages")
        .select("role, content, ptype:payload->>type, said:payload->>text")
        .eq("conversation_id", convId)
        .lt("created_at", before ?? "infinity")
        // Newest first, then turned back round below. Ascending with a
        // limit keeps the OLDEST rows, so past this many messages the
        // assistant was replaying the start of the conversation for
        // ever and had no idea what had just been decided — it asked
        // again for answers it had been given, and designed against
        // requirements the owner had already replaced.
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT)
    : { data: [], error: null };
  if (histErr) throw new Error(histErr.message);

  type HistoryRow = Pick<MessageRow, "role" | "content"> & {
    ptype: string | null;
    said: string | null;
  };
  // Back into the order they were said in; a model reading a
  // conversation backwards is worse than one reading half of it.
  const rows = [...((historyRows ?? []) as HistoryRow[])].reverse();

  // Replay the owner's actual words, not the CONTEXT-wrapped turn we
  // sent at the time: that block is a snapshot of the schema as it was,
  // and a thread of stale snapshots both costs tokens and contradicts
  // the fresh one on the newest turn.
  // A question whose answer never came (still being answered, stopped,
  // or failed) is not replayed, and neither is the line that stood in
  // for it: the model is told only what was said and answered.
  const history = answeredTurns(rows).map((m): ChatTurn => ({
    role: m.role,
    content: m.role === "user" ? (m.said ?? m.content) : m.content,
  }));

  // Has the owner already seen a design for this thread? New sections may
  // only be built after one — otherwise the assistant can skip straight to
  // creating things the owner never agreed to.
  const blueprintShown = rows.some((m) => m.ptype === "blueprint");
  return { proj, moduleList, currentSchema, currentFeatures, history, blueprintShown };
}

/** The answer's line, filled once; a line already stopped is left as it is. */
export async function settleAnswer(
  client: SupabaseClient,
  job: Pick<TurnJob, "answerId" | "conversationId" | "client">,
  payload: Record<string, unknown>,
  content = ""
): Promise<boolean> {
  if (job.client) return settleClientLine(client, job.answerId, payload, content);
  const { data } = await client
    .from("messages")
    .update({ payload, content })
    .eq("id", job.answerId)
    .eq("payload->>type", "answering")
    .select("id");
  await client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", job.conversationId);
  return (data?.length ?? 0) > 0;
}

/**
 * Everything once the model is done. `charged` is whether the turn keeps
 * its charge — a design written down — so the caller gives it back when
 * not. `later` runs what may follow the answer (learning, the trace, the
 * judge): after the response in a request, awaited in a durable step.
 */
export async function finishTurn(
  client: SupabaseClient,
  job: TurnJob,
  ctx: TurnContext,
  turn: TurnResult,
  usage: TurnUsage | null,
  steps: TurnEvent[],
  later: (fn: () => Promise<unknown>) => void
): Promise<{ last: Record<string, unknown>; charged: boolean }> {
  // Asked by their own AI: ended as a request, in its own thread.
  // ponytail: no trace, learning or rename for these; each writes at a table a client's token may not write.
  if (job.client) return finishClientTurn(client, job, ctx, turn, later);
  let charged = false;
  if (!turn.ok) {
    // Our engine could not produce something it trusts. Charging
    // for that is charging for our own failure.
    await settleAnswer(client, job, {
      type: "unanswered",
      message: "Luke could not get this right, so nothing was changed. Ask again, in other words.",
    });
    later(() =>
      traceTurn(client, {
        projectId: ctx.proj.id,
        conversationId: job.conversationId,
        turnId: job.answerId,
        steps,
        usage,
        repairs: turn.repairs,
        repairErrors: turn.repairErrors,
        unmet: [],
        tookMs: Date.now() - job.askedAt,
      })
    );
    return {
      charged: false,
      last: {
        conversationId: job.conversationId,
        repairs: turn.repairs,
        errors: turn.errors,
        hint: `The assistant tried ${MAX_REPAIR_ATTEMPTS + 1} times and its plan still failed validation, so nothing was changed. Try rephrasing your request.`,
      },
    };
  }

  // Written here, by the server, from what the server actually
  // read — and before the row is stored, so the thread keeps the
  // receipt rather than only this response carrying it. The model
  // is never asked to attest that it looked; an assertion from
  // the thing being checked is not a check. Only an answer about
  // the store gets one: a greeting read no rows.
  // What the calls took, kept with the reply so a reload says the same.
  if (usage) turn.reply.usage = usage;
  // And what it did: the same steps the panel was told, so a
  // thread reopened after a refresh still shows them.
  turn.reply.trace = { steps, ms: Date.now() - job.askedAt };
  if (turn.reply.type === "answer" && turn.reply.kind === "store") {
    turn.reply.grounding = {
      kind: "store_snapshot",
      last_synced_at: turn.store?.snapshot?.last_synced_at ?? null,
      shop: turn.store?.shop_domain ?? "",
      ...(turn.lookedUp.length ? { looked_up: turn.lookedUp } : {}),
    };
  }

  // Into the line that waited for it. Stopped meanwhile, the answer
  // is not kept and the turn is given back.
  await client.from("messages").update({ content: turn.userTurn }).eq("id", job.askedId);
  const kept = await settleAnswer(
    client,
    job,
    turn.repairErrors.length > 0 ? { ...turn.reply, repairErrors: turn.repairErrors } : turn.reply,
    turn.raw
  );
  if (!kept) return { last: { conversationId: job.conversationId, stopped: true }, charged: false };
  const replyId = job.answerId;

  // Only a turn that produced a design, and got it written down,
  // counts.
  //
  // The card shown when the counter runs out says "Asking about
  // your store still works" — and asking is what had been using
  // it up. Every question answered, and every question the
  // assistant asked BACK, spent one of the ten, so a single
  // design that needed one round of clarifying cost two or
  // three. Charged only here rather than never charged, because
  // the charge has to happen before the model runs: a client in
  // a loop pays for its own stop.
  if (turn.reply.type === "plans" || turn.reply.type === "blueprint") {
    charged = true;
    // A second opinion on the design, taken after the reply has
    // gone out and written down where nothing reads it yet. A
    // clarify or an answer has no design to judge.
    const reply = turn.reply;
    const store = turn.store;
    later(() =>
      noteJudgement(client, {
        projectId: ctx.proj.id,
        source: "chat",
        ref: replyId,
        request: job.message.trim(),
        plans: reply.type === "blueprint" ? reply.blueprint.plans : reply.plans,
        modules: ctx.moduleList,
        columns: ctx.currentSchema?.columns,
        store,
        unmet: turn.unmet,
      })
    );
  }

  // What this exchange said about the business, written down for
  // next time (0131) — after the answer is out, never in its way.
  const said = turn.reply;
  later(() => learn(client, { projectId: ctx.proj.id, message: job.message.trim(), reply: said, known: turn.known }));
  later(() =>
    traceTurn(client, {
      projectId: ctx.proj.id,
      conversationId: job.conversationId,
      turnId: replyId,
      steps,
      usage: usage ?? null,
      repairs: turn.repairs,
      repairErrors: turn.repairErrors,
      unmet: turn.unmet,
      tookMs: Date.now() - job.askedAt,
    })
  );
  // A thread is named after whatever was typed first, which is
  // how six of them end up called "hello". Once a design exists
  // there is something better to call it — and only then, because
  // renaming on every turn would move a thread the owner was
  // looking for.
  //
  // The model names the conversation on every reply now, and keeps
  // the name while the subject holds, so the list reads as what each
  // thread was about ("Pending COD payments") rather than "hello".
  // Without one, the old rule: named once, from the design.
  //
  // A name the owner gave in the list is theirs (0126): the reply
  // moves the thread up, and leaves its name alone.
  const named =
    turn.reply.title ?? (job.isNewConversation || looksLikeAGreeting(job.message) ? titleFor(turn.reply) : null);
  await client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", job.conversationId);
  if (named) {
    await client
      .from("conversations")
      .update({ title: named })
      .eq("id", job.conversationId)
      .eq("named_by_owner", false);
  }

  // The reply's row, so the panel can show it under that id and a
  // reload of the thread knows which reply it already has on screen.
  return { last: { conversationId: job.conversationId, reply: turn.reply, repairs: turn.repairs, replyId }, charged };
}

/** Words that say nothing about what the thread is for. */
function looksLikeAGreeting(message: string): boolean {
  return /^(hi|hey|hello|yo|test|hola|namaste)\b[\s!.?]*$/i.test(message.trim());
}

/**
 * What to call a thread, taken from what the assistant decided to do
 * rather than from the first thing anybody typed.
 */
function titleFor(reply: AssistantReply): string | null {
  const from =
    reply.type === "blueprint"
      ? (reply.blueprint.summary ?? reply.message)
      : reply.type === "plans"
        ? reply.message
        : null;
  const line = from?.split(/[.\n]/)[0]?.trim();
  return line && line.length > 3 ? line.slice(0, TITLE_MAX) : null;
}
