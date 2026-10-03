// What the reviewers that read a design after the critic hand back: the
// shapes shared by the review gate (lib/review-gate.ts), the data check
// (lib/data-check.ts), the rule dry-run (lib/dry-run.ts) and the screen
// review (lib/ux-review.ts).
//
// Callers: src/lib/review-gate.ts, src/lib/data-check.ts, src/lib/dry-run.ts,
// src/lib/ux-review.ts, src/lib/types.ts, src/components/ChatPanel.tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreContext } from "@/lib/ai";
import type { ModuleRow, UiSchema } from "@/lib/types";

/** What every reviewer reads: the caller's own client, so RLS decides what it may see. */
export type ReviewContext = {
  db: SupabaseClient;
  projectId: string;
  store: StoreContext | null;
  modules: ModuleRow[];
  schemas: Map<string, UiSchema>;
  ownerWords: string;
  /** What Luke understood, as the plan block the design read; "" when there was none. */
  understood: string;
  locale: string;
  currency: string;
  /** The model the screen review looks on, or null: the setting is the switch. */
  uxModel: string | null;
  signal?: AbortSignal;
};

/** A value or a field the design leans on, checked against the store's own rows. */
export type DataFinding = { plan: number; text: string; severity: "problem" | "note" };

/** A rule of the design, run in the head over the rows it would meet. */
export type DryRun = {
  plan: number;
  rule: string;
  section: string;
  /** Rows its condition matches (or that it would change); null when it cannot be told without running code. */
  matched: number | null;
  /** Rows looked at. */
  of: number | null;
  /** A few of the rows it matches, by their own label (an order number, a product title), never a person's details. */
  sample: string[];
  note: string | null;
  /** It would touch every row it looked at, and there were enough to mean it. */
  everyRow: boolean;
};

/** What the screen review saw. */
export type UxVerdict = {
  verdict: "pass" | "redo" | "skipped";
  how: "screenshot" | "text" | "none";
  issues: string[];
  /** One line to the designer when it goes back. */
  fix: string | null;
  ms: number;
};

/** Everything the reviewers said of the design that was built, kept on the reply for its card. */
export type DesignChecks = {
  simplicity: { verdict: "simple" | "redo"; why: string | null } | null;
  data: DataFinding[];
  dryRuns: DryRun[];
  ux: UxVerdict | null;
};
