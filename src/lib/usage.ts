// What a turn's model calls took: tokens by model, and what they cost.
//
// A reply is more than one call: repairs, the lookup fold, the gap pass,
// the question router. Each call records itself here once it finishes,
// into the meter of the turn it runs in. The meter is carried by
// AsyncLocalStorage, so no call site threads a counter through, and a
// call outside a metered turn (a check, the judge after the reply)
// records nothing. Uses are summed by provider, model and job, the way
// CopilotKit sums a run's usage, and priced once, when the turn ends.
//
// Callers: src/lib/ai.ts (every call), src/lib/jev.ts (the router),
// src/app/api/chat/route.ts (the meter around a turn).

import { AsyncLocalStorage } from "node:async_hooks";
import { costOf, type Tokens } from "@/lib/model-prices";
import type { ModelUse, TurnUsage, UsageJob as Job } from "@/lib/types";

export type { ModelUse, TurnUsage };

type Meter = { uses: ModelUse[]; replyModel: string | null };
const meters = new AsyncLocalStorage<{ meter: Meter; job: Job }>();

/** A count only when it is one: a safe, non-negative integer. */
const count = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);

/** The SDK's usage shape; a provider's own is turned into it by the caller. */
export type UsageIn = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
};

/** One finished call. Outside a metered turn, nothing. */
export function record(provider: string, model: string | undefined, usage: UsageIn | undefined, job?: Job) {
  const at = meters.getStore();
  if (!at || !model || !usage) return;
  const as = job ?? at.job;
  const t: Tokens = {
    input: count(usage.inputTokens),
    cacheRead: count(usage.inputTokenDetails?.cacheReadTokens),
    cacheWrite: count(usage.inputTokenDetails?.cacheWriteTokens),
    output: count(usage.outputTokens),
  };
  if (as === "reply") at.meter.replyModel = model;
  const same = at.meter.uses.find((u) => u.provider === provider && u.model === model && u.job === as);
  if (!same) {
    at.meter.uses.push({ provider, model, job: as, calls: 1, ...t, usd: null });
    return;
  }
  same.calls += 1;
  for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) {
    const sum = same[k] + t[k];
    if (Number.isSafeInteger(sum)) same[k] = sum;
  }
}

/** Runs a turn with a meter; what it took is read after, once the turn is over. */
export async function metered<T>(fn: () => Promise<T>): Promise<[T, () => TurnUsage | null]> {
  const meter: Meter = { uses: [], replyModel: null };
  const result = await meters.run({ meter, job: "reply" }, fn);
  return [result, () => summarise(meter)];
}

/** Runs part of a turn as another job: its calls are counted apart. */
export function asJob<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  const at = meters.getStore();
  return at ? meters.run({ meter: at.meter, job }, fn) : fn();
}

export function summarise(meter: Meter): TurnUsage | null {
  if (meter.uses.length === 0) return null;
  const uses = meter.uses.map((u) => ({ ...u, usd: costOf(u.model, u) }));
  return {
    model: meter.replyModel,
    uses,
    usd: uses.reduce((s, u) => s + (u.usd ?? 0), 0),
    partial: uses.some((u) => u.usd === null),
  };
}
