// A change the merchant's own AI asked for (propose_change), run as a
// Luke turn in a thread of its own (0139), and how that turn ends.
//
// It used to be designed inside the one request that asked and kept only
// if it finished there as a design: a question back, a failure or a turn
// past the function's time was dropped, and the assistant was told to
// look for a request that would never exist. Now the thread holds
// whatever it ended in, the merchant sees it in Luke's panel, and the
// assistant's own answer is kept on the same line for when it asks again.
//
// Callers: src/lib/turn-run.ts (finishTurn, settleAnswer), src/app/api/mcp/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { modelErrorKindOf } from "@/lib/ai";
import { blueprintAsText, type TurnResult } from "@/lib/engine";
import { openAt, settleDesign, text, type Json } from "@/lib/client-design";
import { undoableFrom } from "@/lib/undo";
import { afterOwnerTurn } from "@/lib/learning";
import type { TurnContext, TurnJob } from "@/lib/turn-run";

/** The line an ask is answered on, filled once; false when it was stopped or filled already. */
export async function settleClientLine(
  client: SupabaseClient,
  answerId: string,
  payload: Record<string, unknown>,
  content = ""
): Promise<boolean> {
  const { data, error } = await client.rpc("abo_client_settle", {
    p_answer: answerId,
    p_payload: payload,
    p_content: content,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/** An assistant's answer with more said in it: the thread it can carry on in. */
function saying(answer: Json, more: Json): Json {
  const content = answer.content as Array<{ type: string; text: string }> | undefined;
  const first = content?.[0];
  if (!first || first.type !== "text") return answer;
  try {
    const said = JSON.parse(first.text) as Json;
    return {
      ...answer,
      content: [{ ...first, text: JSON.stringify({ ...said, ...more }, null, 2) }, ...content.slice(1)],
    };
  } catch {
    return answer;
  }
}

/** What an answer says, read back from its text. */
function saidIn(answer: Json): Json {
  try {
    return JSON.parse((answer.content as Array<{ text: string }>)[0]?.text ?? "{}") as Json;
  } catch {
    return {};
  }
}

const stoppedAnswer = (conversationId: string) =>
  text({
    status: "stopped",
    note: "The merchant stopped this in Warmluke. Nothing was requested or built.",
    conversation_id: conversationId,
  });

/**
 * The turn done: a design settled as a request (built if the merchant
 * said it may be), a question put to the merchant, or why it failed —
 * written on the thread's line, with the assistant's answer beside it.
 * `charged` is whether the turn keeps its charge: a request written down.
 */
export async function finishClientTurn(
  client: SupabaseClient,
  job: TurnJob,
  ctx: TurnContext,
  turn: TurnResult,
  later: (fn: () => Promise<unknown>) => void
): Promise<{ last: Json; charged: boolean }> {
  const origin = job.client?.origin ?? "";
  const thread = { conversation_id: job.conversationId };

  // Stopped in Warmluke while it was designed, or its conversation
  // deleted: nothing is requested, and nothing is built behind the
  // merchant's back.
  const { data: line } = await client.from("messages").select("payload->>type").eq("id", job.answerId).maybeSingle();
  if (!line || (line as { type?: string }).type === "stopped") {
    return { last: stoppedAnswer(job.conversationId), charged: false };
  }

  if (!turn.ok) {
    const answer = text({
      error: "Warmluke could not turn that into a design it trusts.",
      detail: turn.errors.slice(0, 3),
      note: "Say it again with more about how they actually work, and what should happen when.",
      ...thread,
    });
    // A model that was not there is said as itself (turn-run.ts, finishTurn).
    const failed = modelErrorKindOf(turn.errors[0] ?? "");
    await settleClientLine(client, job.answerId, {
      type: "unanswered",
      message: failed
        ? turn.errors[0]
        : "Luke could not get this right, so nothing was changed. Ask again, in other words.",
      ...(failed ? { failed } : {}),
      mcp: answer,
    });
    return { last: answer, charged: false };
  }

  const reply = turn.reply;
  // What this ask teaches, as a turn in Luke's own chat does (5 Oct): an
  // ask through the owner's own AI is one of theirs, and Luke grows with
  // the store however it is reached. A builder's ask is not (0140).
  if (ctx.proj.owner_id === job.userId)
    later(() =>
      afterOwnerTurn(client, {
        projectId: ctx.proj.id,
        conversationId: job.conversationId,
        turnId: job.answerId,
        message: job.message.trim(),
        reply,
        known: turn.known,
        learned: turn.learned,
        repairs: turn.repairs,
        criticRedo: turn.criticRedo,
        sentBack: turn.sentBackWhy,
        viaTheirAI: true,
      })
    );
  // Asked back, not guessed at: the merchant sees the questions in this
  // thread and can answer here, and the assistant hears them too, and
  // carries on in the same thread with their answers.
  if (reply.type === "clarify") {
    const answer = text({
      status: "needs answers",
      note: "Nothing has been requested yet. Ask the merchant these, then call propose_change again with their answers and this conversation_id. They can also answer in Warmluke, where the questions are waiting in this conversation.",
      message: reply.message,
      questions: reply.questions,
      ...thread,
      open: openAt(origin, job.projectId),
    });
    await settleClientLine(client, job.answerId, { ...reply, mcp: answer }, turn.raw);
    return { last: answer, charged: false };
  }
  // This path designs a change; a question for Luke is answered in the thread, and refused here.
  if (reply.type === "answer") {
    const answer = text({ error: "That reads as a question, not a change to make.", ...thread });
    await settleClientLine(client, job.answerId, { ...reply, mcp: answer }, turn.raw);
    return { last: answer, charged: false };
  }

  const plans = reply.type === "blueprint" ? reply.blueprint.plans : reply.plans;
  const next = (reply.type === "blueprint" ? reply.blueprint.next : reply.next)?.slice(0, 2);
  let charged = false;
  const settled = await settleDesign({
    db: client,
    origin,
    project: ctx.proj,
    moduleList: ctx.moduleList,
    plans,
    design: blueprintAsText(reply, ctx.moduleList, turn.store, turn.unmet),
    unmet: turn.unmet ?? [],
    next,
    request: job.message,
    store: turn.store,
    // Charged the moment the request row exists, as it always was.
    charged: () => {
      charged = true;
    },
    later,
    inThread: true,
  });
  // Their AI drew this one (submit_design): what Luke found in it and
  // changed before the merchant saw it, said, never done quietly.
  const changed = job.design ? [...turn.repairErrors.slice(0, 3), ...(turn.sentBackWhy ? [turn.sentBackWhy] : [])] : [];
  const answer = saying(settled.answer, {
    ...thread,
    ...(job.design
      ? {
          checked_by_luke: changed.length
            ? {
                changed: true,
                why: changed,
                note: "Luke changed the design you sent before the merchant saw it. The design here is the one they see.",
              }
            : { changed: false },
        }
      : {}),
  });
  const said = saidIn(answer);
  const undo = undoableFrom(settled.applied);
  const payload =
    settled.status === "built" || settled.status === "partly built"
      ? {
          type: "applied",
          message: settled.line,
          ...(undo.length ? { undo } : {}),
          ...(next?.length ? { next } : {}),
          request_id: settled.requestId,
          mcp: answer,
        }
      : settled.status === "waiting"
        ? {
            type: "answer",
            kind: "conversation",
            message: `Designed${
              typeof said.not_automatic_because === "string"
                ? `, and not built on its own: ${said.not_automatic_because}`
                : ""
            }. It waits for your yes under the bell above.`,
            request_id: settled.requestId,
            mcp: answer,
          }
        : { type: "unanswered", message: `The design could not be saved: ${String(said.error ?? "")}`, mcp: answer };
  await settleClientLine(client, job.answerId, payload, turn.raw);
  return { last: answer, charged };
}

/** How often a waiting request looks at the line. */
const ANSWER_POLL_MS = 750;

/**
 * The line's answer once it has one, looked for until `ms` is up: what a
 * request that asked waits for, and gives up on without losing anything.
 */
export async function answerWhenReady(
  db: SupabaseClient,
  answerId: string,
  ms: number
): Promise<Record<string, unknown> | null> {
  const until = Date.now() + ms;
  for (;;) {
    const { data } = await db.from("messages").select("payload").eq("id", answerId).maybeSingle();
    const p = (data as { payload?: Record<string, unknown> } | null)?.payload;
    if (p && p.type !== "answering") return p;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, Math.min(ANSWER_POLL_MS, until - Date.now())));
  }
}

/** What the assistant is told of a line that has its answer. */
export function answerFor(line: Record<string, unknown>, conversationId: string): Json {
  if (line.mcp && typeof line.mcp === "object") return line.mcp as Json;
  if (line.type === "stopped") return stoppedAnswer(conversationId);
  return text({
    error: typeof line.message === "string" ? line.message : "Luke could not answer this.",
    conversation_id: conversationId,
  });
}
