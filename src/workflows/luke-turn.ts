// A turn that is not bound by one function's time (LUKE_WORKFLOW=1).
//
// A design turn is a plan, up to three design attempts and the critic
// after each: past five minutes for a big ask, and a function is stopped
// at five. So the turn runs in legs. Each leg is a durable step with a
// function's time of its own: it reads the app and the thread afresh,
// goes on from where the last leg stopped (engine.ts, TurnState), and
// hands its state on when too little time is left for another attempt.
// A leg that dies is run again from the state it was handed, not from
// the start; attempts already made are not paid for twice. The last
// step does everything the chat route does once the model is done
// (lib/turn-run.ts), gives the turn back when it made no design, and
// ends the stream.
//
// The browser reads the same lines as ever, from the run's own stream;
// one that goes away and comes back finds the answer on its thread.
//
// Callers: src/app/api/chat/route.ts.

import { getWritable } from "workflow";
import { runTurn, type TurnResult, type TurnState } from "@/lib/engine";
import { lukeSettings, modelFor } from "@/lib/luke-models";
import { clientForToken } from "@/lib/supabase-server";
import { finishTurn, settleAnswer, turnContext, type TurnJob } from "@/lib/turn-run";
import type { ProjectRow, TurnEvent, TurnUsage } from "@/lib/types";
import { combine, metered } from "@/lib/usage";

export type DurableTurn = TurnJob & {
  /** The owner's own token, verified by the route: every leg reads and writes as them. */
  token: string;
  /** The charge this turn may give back (abo_spend_turn), when it makes no design. */
  spendId: string | null;
};

/** How long a leg works before handing on: short of a function's five minutes, with room to hand over. */
const LEG_MS = () => Number(process.env.LUKE_LEG_MS) || 240_000;
/** Legs at most: three attempts and a plan fit in far fewer; this is the guard, not the plan. */
const MAX_LEGS = 8;
/** How often a draft of the words is sent, as the chat route does. */
const WORDS_EVERY_MS = 80;
/** How often a leg looks for the owner's stop. */
const STOP_POLL_MS = 1500;

type Leg = { turn: TurnResult; usage: TurnUsage | null; steps: TurnEvent[] };

export async function lukeTurn(job: DurableTurn) {
  "use workflow";
  let state: TurnState | null = null;
  const usages: Array<TurnUsage | null> = [];
  const steps: TurnEvent[] = [];
  for (let leg = 0; leg < MAX_LEGS; leg++) {
    let out: Leg;
    try {
      out = await turnLeg(job, state);
    } catch (e) {
      const why = e instanceof Error ? e.message : "The turn could not go on.";
      await finishLeg(job, { ok: false, errors: [why], repairs: 0, repairErrors: [] }, usages, steps);
      return;
    }
    usages.push(out.usage);
    steps.push(...out.steps);
    const paused = !out.turn.ok ? out.turn.paused : undefined;
    if (paused && leg < MAX_LEGS - 1) {
      state = paused;
      continue;
    }
    await finishLeg(job, out.turn, usages, steps);
    return;
  }
}

async function projectOf(job: DurableTurn) {
  const client = clientForToken(job.token);
  const { data, error } = await client.from("projects").select("*").eq("id", job.projectId).single();
  if (error || !data) throw new Error(error?.message ?? "The project is not there.");
  return { client, proj: data as ProjectRow };
}

/** One leg: the turn from where it stood, until it ends or has to hand on. */
async function turnLeg(job: DurableTurn, state: TurnState | null): Promise<Leg> {
  "use step";
  const { client, proj } = await projectOf(job);
  const ctx = await turnContext(client, proj, {
    projectId: job.projectId,
    moduleId: job.moduleId,
    conversationId: job.conversationId,
    before: new Date(job.askedAt).toISOString(),
    userId: job.userId,
  });
  // One writer for the leg: writes queue in order, and two never race for the lock.
  const writer = getWritable<unknown>().getWriter();
  const say = (o: unknown) => void writer.write(o).catch(() => {});
  const steps: TurnEvent[] = [];
  const tell = (e: TurnEvent) => {
    steps.push(e);
    say(e);
  };
  // "accepted" is said by the route as the run starts (api/chat), not
  // here: a leg begins seconds later, and a stop pressed in between had
  // no turn to mark.

  // The draft, one line at most every WORDS_EVERY_MS, as the route sends it.
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let latest = "";
  let phase: string | undefined;
  let sentAt = 0;
  const send = () => {
    waiting = null;
    sentAt = Date.now();
    say({ words: latest, ...(phase ? { phase } : {}) });
  };
  const words = (text: string, next?: string) => {
    latest = text;
    phase = next;
    if (text === "") {
      if (waiting) clearTimeout(waiting);
      send();
      return;
    }
    if (!waiting) waiting = setTimeout(send, Math.max(0, WORDS_EVERY_MS - (Date.now() - sentAt)));
  };

  // Stop is a mark on the answer's line; the leg looks for it while it
  // runs, and once before the model is asked: a stop pressed as the
  // question went is already there, and nothing is asked at all.
  const halt = new AbortController();
  const look = async () => {
    const { data } = await client.from("messages").select("payload->>type").eq("id", job.answerId).maybeSingle();
    if ((data as { type?: string } | null)?.type === "stopped") halt.abort();
  };
  const watch = setInterval(look, STOP_POLL_MS);

  try {
    await look();
    // An abort is final: the runtime does not retry it (workflow docs, cancellation).
    halt.signal.throwIfAborted();
    const luke = await lukeSettings(client, job.userId);
    const picked = modelFor(luke, job.askedModel);
    const [turn, took] = await metered(() =>
      runTurn({
        client,
        project: proj,
        modules: ctx.moduleList,
        message: job.message,
        history: ctx.history,
        currentSchema: ctx.currentSchema,
        currentFeatures: ctx.currentFeatures,
        blueprintShown: ctx.blueprintShown,
        moduleId: job.moduleId,
        // Asked by their own AI (propose_change): the turn that door
        // always ran, which designs plain plans and looks nothing up.
        // ponytail: no lookups for these, so their recordings still play; turn it on and record them to give them Luke's.
        lookups: !job.client,
        ...(job.client ? { plansAllowed: true } : {}),
        signal: halt.signal,
        onEvent: tell,
        onWords: job.client ? undefined : words,
        model: picked && picked !== luke.server ? picked : undefined,
        deadline: Date.now() + LEG_MS(),
        resume: state ?? undefined,
      })
    );
    return { turn, usage: took(), steps };
  } finally {
    clearInterval(watch);
    // The draft still waiting goes out: the reply comes in a later step,
    // so it cannot arrive after the reply it is a draft of.
    if (waiting) {
      clearTimeout(waiting);
      send();
    }
    await writer.ready.catch(() => {});
    writer.releaseLock();
  }
}

/** The turn done: written down, charged or given back, and its stream ended. */
async function finishLeg(
  job: DurableTurn,
  turn: TurnResult,
  usages: Array<TurnUsage | null>,
  steps: TurnEvent[]
): Promise<void> {
  "use step";
  const writer = getWritable<unknown>().getWriter();
  let charged = false;
  const { client, proj } = await projectOf(job);
  try {
    const ctx = await turnContext(client, proj, {
      projectId: job.projectId,
      moduleId: job.moduleId,
      conversationId: job.conversationId,
      before: new Date(job.askedAt).toISOString(),
      userId: job.userId,
    });
    // What follows the answer runs here and is waited for: a step has no after().
    const later: Array<() => Promise<unknown>> = [];
    // Read again here: a step is replayed on its own, with only what it was handed.
    const luke = await lukeSettings(client, job.userId);
    const done = await finishTurn(
      client,
      job,
      ctx,
      turn,
      combine(usages),
      steps,
      (fn) => later.push(fn),
      luke.shows === "tokens" || luke.shows === "cost"
    );
    charged = done.charged;
    await writer.write(done.last);
    await Promise.all(later.map((fn) => fn().catch(() => {})));
  } catch (e) {
    const why = e instanceof Error ? e.message : "Unknown error";
    await settleAnswer(client, job, { type: "unanswered", message: why }).catch(() => false);
    await writer.write({ error: why, conversationId: job.conversationId }).catch(() => {});
  } finally {
    // ponytail: abo_refund_turn gives back only a spend of the last five
    // minutes; a turn that ran longer and made no design keeps its charge.
    if (!charged && job.spendId) await client.rpc("abo_refund_turn", { p_spend: job.spendId });
    await writer.close().catch(() => {});
  }
}
