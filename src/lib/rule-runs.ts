// What a project's rules did, run by run, newest first (0206, abo_rule_runs).
//
// For Luke and the owner's own AI, which read it instead of asking the
// owner to go and look (Tanish, 11 Oct: "it should know that, and not ask
// me to check it for him"). Every kind of rule is here: expressions, code
// after a write or from the queue, and an AI step. Read with the caller's
// own client, so a rule they cannot see is not in it.
//
// Callers: src/app/api/mcp/route.ts (rule_runs), Luke's own tool (lib/engine).

import type { SupabaseClient } from "@supabase/supabase-js";

export type RuleRun = {
  /** The rule's name. */
  rule: string;
  /** When it ran (ISO). */
  at: string;
  /** False when its code failed, or a write it made was refused (`error` says which). */
  ok: boolean;
  /** What set it off, in words: "a row added", "its schedule"… */
  trigger: string;
  /** Rows it was handed of each section it read, by the section's name, and whether that was cut short. */
  read: Record<string, { rows: number; cut: boolean }>;
  /** Rows it wrote or added; 0 when it wrote none, or when the run did not say. */
  wrote: number;
  error: string | null;
  /** Writes it handed back past what one run may make, left unmade; said only when there were any. */
  note?: string;
};

const TRIGGERS: Record<string, string> = {
  record_created: "a row added",
  record_updated: "a row changed",
  schedule: "its schedule",
  store_row_added: "a row the store brought in",
  before_save: "a row about to be saved",
};

type Raw = {
  rule: string;
  at: string;
  ok: boolean;
  trigger: string | null;
  read: unknown;
  wrote: number | null;
  dropped: number | null;
  error: string | null;
};

/** The newest runs of a project's rules, or of one rule by its name or id. */
export async function readRuleRuns(
  client: SupabaseClient,
  projectId: string,
  opts: { rule?: string; limit?: number } = {}
): Promise<RuleRun[]> {
  const { data, error } = await client.rpc("abo_rule_runs", {
    p_project: projectId,
    p_rule: opts.rule?.trim() || null,
    p_limit: Math.min(Math.max(Math.trunc(Number(opts.limit) || 20), 1), 200),
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Raw[]).map((r) => ({
    rule: r.rule,
    at: r.at,
    ok: r.ok,
    trigger: TRIGGERS[r.trigger ?? ""] ?? r.trigger ?? "",
    read: readOf(r.read),
    wrote: r.wrote ?? 0,
    error: r.error,
    ...(r.dropped ? { note: `${r.dropped} more writes were past what one run may make, and were not made.` } : {}),
  }));
}

/** What a run kept of its reads, held to its shape. */
function readOf(v: unknown): RuleRun["read"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: RuleRun["read"] = {};
  for (const [name, s] of Object.entries(v as Record<string, { rows?: unknown; cut?: unknown }>)) {
    out[name] = { rows: Number(s?.rows) || 0, cut: s?.cut === true };
  }
  return out;
}
