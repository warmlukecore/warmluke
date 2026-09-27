// Every turn leaves a trace (0132): what it did, read back as one row.
//
// The steps the panel was told, what the calls took, how many repairs
// and for what, what the plan understood, what the critic said, how
// long it all took. Written after the reply is out, on the owner's own
// client, and never in the answer's way: a trace missed is a trace
// missed.
//
// Callers: src/app/api/chat/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TurnEvent, TurnUsage } from "@/lib/types";

export type TurnTrace = {
  projectId: string;
  conversationId: string | null;
  turnId: string | null;
  steps: TurnEvent[];
  usage: TurnUsage | null;
  repairs: number;
  repairErrors: string[];
  unmet: string[];
  tookMs: number;
};

/** What the steps say a turn was: its road, what was understood, the critic's word. */
export function readSteps(steps: TurnEvent[]): {
  road: string | null;
  planGoal: string | null;
  critic: { verdict: string; missing: number } | null;
} {
  let road: string | null = null;
  let planGoal: string | null = null;
  let critic: { verdict: string; missing: number } | null = null;
  for (const s of steps) {
    if (s.step === "road") road = s.road;
    else if (s.step === "plan" && s.goal) planGoal = s.goal;
    else if (s.step === "critic") critic = { verdict: s.verdict, missing: s.missing };
  }
  return { road, planGoal, critic };
}

export async function traceTurn(db: SupabaseClient, t: TurnTrace): Promise<void> {
  try {
    const { road, planGoal, critic } = readSteps(t.steps);
    const { error } = await db.from("turn_traces").insert({
      project_id: t.projectId,
      conversation_id: t.conversationId,
      turn_id: t.turnId,
      road,
      model: t.usage?.model ?? null,
      steps: t.steps,
      usage: t.usage,
      repairs: t.repairs,
      repair_errors: t.repairErrors,
      unmet: t.unmet,
      plan_goal: planGoal,
      critic,
      took_ms: Math.max(0, Math.round(t.tookMs)),
    });
    if (error) console.error(`[trace] ${error.message}`);
  } catch (e) {
    console.error(`[trace] ${e instanceof Error ? e.message : "failed"}`);
  }
}
