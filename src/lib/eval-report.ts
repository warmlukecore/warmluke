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

/** said: the grader's own yes, before its quote was checked (runs before 4 Oct read it off the evidence's "not counted" note). */
export type Criterion = { text: string; met: boolean; said?: boolean; evidence: string };
export type MustNot = { text: string; hit: boolean; evidence: string };

/** What code saw, without a model: the 0175 workaround signs, jargon the owner read, and the order of things. */
export type Signs = {
  workarounds: string[];
  jargon: string[];
  /** A plan said in words came before the first build (or, with nothing built, came at all). */
  proposed_first: boolean;
};

export type Line = { who: "owner" | "luke" | "app"; text: string };

/**
 * What code saw of the outcome, without a model (12 Oct): the number in the
 * answer, the rows a build points at, a question asked first, a plain "I
 * can't" where the platform can't, no "I can't" where it can, the builds it
 * took. Each one passes or fails, with what it saw.
 */
export type Check = { name: string; ok: boolean; detail: string };

export type CaseResult = {
  id: string;
  title: string;
  /** build (the default), question, vague or limit; runs before 12 Oct have none. */
  kind?: string;
  /** The shop the case's store was seeded with; "seed" when absent. */
  shop?: string;
  /** Luke's turns: messages the owner sent. */
  turns: number;
  built: boolean;
  signs: Signs;
  criteria: Criterion[];
  must_not: MustNot[];
  scores: Scores;
  /** The outcome as code saw it (12 Oct); absent on older runs. */
  checks?: Check[];
  /** Out of 10: every check, criterion and must-not, as one share (scoreOf). */
  score10?: number;
  /** Dollars: Luke's priced usage, the simulated owner's calls and the grader's. */
  cost: number;
  /** Milliseconds Luke took, all turns together. */
  ms: number;
  transcript?: Line[];
  /** Each of Luke's turns as its trace had it (gone with the case's project once the case ends). */
  trace?: TurnTrace[];
};

/** A turn's trace, kept: its steps as short lines, its repairs and what the validator refused. */
export type TurnTrace = { turn: number; repairs: number; refused: string[]; steps: string[] };

/** A case the cap or a failure stopped part way: what was said and traced, never graded. */
export type UnfinishedCase = { id: string; title: string; stopped: string; transcript: Line[]; trace: TurnTrace[] };

export type RunSummary = {
  pass_rate: number;
  /** The mean of every case's score out of 10 (12 Oct); absent on older runs. */
  score10?: number;
  /** Of every success criterion in the run, the share the grader said yes to: one measure across runs. */
  said_rate?: number;
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
  /** Out of the summary, as never graded. */
  unfinished?: UnfinishedCase[];
  summary: RunSummary;
};

/** A line of evals/runs/index.json. */
export type RunEntry = { file: string; label: string; started: string; summary: RunSummary };

/** Passed: every check ok, every success criterion met, and nothing it must not do; something was graded. */
export const casePassed = (c: Pick<CaseResult, "criteria" | "must_not" | "checks">): boolean =>
  c.criteria.length + (c.checks?.length ?? 0) > 0 &&
  c.criteria.every((x) => x.met) &&
  c.must_not.every((x) => !x.hit) &&
  (c.checks ?? []).every((x) => x.ok);

/** Out of 10: the share of checks passed, criteria met and must-nots clear, to one place. */
export function scoreOf(c: Pick<CaseResult, "criteria" | "must_not" | "checks">): number {
  const checks = c.checks ?? [];
  const all = checks.length + c.criteria.length + c.must_not.length;
  if (all === 0) return 0;
  const good =
    checks.filter((x) => x.ok).length +
    c.criteria.filter((x) => x.met).length +
    c.must_not.filter((x) => !x.hit).length;
  return Math.round((good / all) * 100) / 10;
}

/** The signs a case counts: each workaround, each jargon word, and a build with no plan said first. */
export const signCount = (c: Pick<CaseResult, "signs" | "built">): number =>
  c.signs.workarounds.length + c.signs.jargon.length + (c.built && !c.signs.proposed_first ? 1 : 0);

/** The grader's yes: kept as "said" from 4 Oct, read off the "not counted" note before. */
export const saidYes = (x: Criterion): boolean => x.said ?? (x.met || x.evidence.startsWith("(not counted:"));

const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** A run's numbers, from the cases that finished. */
export function summarise(cases: CaseResult[]): RunSummary {
  return {
    pass_rate: round(cases.length ? cases.filter(casePassed).length / cases.length : 0, 3),
    score10: round(mean(cases.map((c) => c.score10 ?? scoreOf(c))), 1),
    said_rate: round(mean(cases.flatMap((c) => c.criteria.map((x) => (saidYes(x) ? 1 : 0)))), 3),
    avg_scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, round(mean(cases.map((c) => c.scores[k])), 2)])) as Scores,
    signs_total: cases.reduce((n, c) => n + signCount(c), 0),
    cost: round(
      cases.reduce((n, c) => n + c.cost, 0),
      4
    ),
    avg_ms: Math.round(mean(cases.map((c) => c.ms))),
  };
}
