// What an eval run of Luke is, and the arithmetic over it.
//
// scripts/eval-luke.mjs writes a run; the console's Evals page reads it.
// Both count a pass and a sign here, so the number the harness printed
// and the number the page shows cannot be counted two ways.
//
// No imports, so the harness reads it with plain Node.
//
// Callers: scripts/eval-luke.mjs, scripts/check-eval-harness.mjs,
// src/app/[gate]/evals/page.tsx, evals/runs/all.ts.

export const SCORE_KEYS = ["discussed", "plain", "better_idea", "simplest"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number>;

/** What each score is called on the page. */
export const SCORE_NAMES: Record<ScoreKey, string> = {
  discussed: "Discussed first",
  plain: "Plain words",
  better_idea: "Better idea",
  simplest: "Simplest design",
};

export type Criterion = { text: string; met: boolean; evidence: string };
export type MustNot = { text: string; hit: boolean; evidence: string };

/** What code saw, without a model: the 0175 workaround signs, jargon the owner read, and the order of things. */
export type Signs = {
  workarounds: string[];
  jargon: string[];
  /** A plan said in words came before the first build (or, with nothing built, came at all). */
  proposed_first: boolean;
};

export type Line = { who: "owner" | "luke" | "app"; text: string };

export type CaseResult = {
  id: string;
  title: string;
  /** Luke's turns: messages the owner sent. */
  turns: number;
  built: boolean;
  signs: Signs;
  criteria: Criterion[];
  must_not: MustNot[];
  scores: Scores;
  /** Dollars: Luke's priced usage, the simulated owner's calls and the grader's. */
  cost: number;
  /** Milliseconds Luke took, all turns together. */
  ms: number;
  transcript?: Line[];
};

export type RunSummary = {
  pass_rate: number;
  avg_scores: Scores;
  signs_total: number;
  cost: number;
  avg_ms: number;
};

export type EvalRun = {
  label: string;
  started: string;
  design_model: string;
  sim_model: string;
  grade_model: string;
  cap: number;
  /** Everything the run spent, a case the cap cut short included. */
  spent: number;
  /** Stopped before every case was run: the cap, or a failure. */
  partial: boolean;
  cases: CaseResult[];
  summary: RunSummary;
};

/** A line of evals/runs/index.json. */
export type RunEntry = { file: string; label: string; started: string; summary: RunSummary };

/** Passed: every success criterion met, and nothing it must not do. */
export const casePassed = (c: Pick<CaseResult, "criteria" | "must_not">): boolean =>
  c.criteria.length > 0 && c.criteria.every((x) => x.met) && c.must_not.every((x) => !x.hit);

/** The signs a case counts: each workaround, each jargon word, and a build with no plan said first. */
export const signCount = (c: Pick<CaseResult, "signs" | "built">): number =>
  c.signs.workarounds.length + c.signs.jargon.length + (c.built && !c.signs.proposed_first ? 1 : 0);

const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** A run's numbers, from the cases that finished. */
export function summarise(cases: CaseResult[]): RunSummary {
  return {
    pass_rate: round(cases.length ? cases.filter(casePassed).length / cases.length : 0, 3),
    avg_scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, round(mean(cases.map((c) => c.scores[k])), 2)])) as Scores,
    signs_total: cases.reduce((n, c) => n + signCount(c), 0),
    cost: round(
      cases.reduce((n, c) => n + c.cost, 0),
      4
    ),
    avg_ms: Math.round(mean(cases.map((c) => c.ms))),
  };
}
