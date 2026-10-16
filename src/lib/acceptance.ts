// ─────────────────────────────────────────────────────────────
// The sprint's acceptance (16 Oct, Days 14–15): the ten critical
// scenarios, each tied to what already proves it (a check run on its own
// database, a browser walk, eval cases), and the scorecard a 25 × 3 eval
// run is read into: at least 90% of runs finished end to end, every
// critical case passed on every run, and time, cost and calls by kind of
// task at p50 and p95. Pure, so check-acceptance tests it without a run.
//
// Callers: scripts/acceptance.mjs, scripts/check-acceptance.mjs.
// ─────────────────────────────────────────────────────────────

import { casePassed, type CaseResult } from "@/lib/eval-report";

export type Critical = {
  id: string;
  /** What must hold on every run, in the owner's terms. */
  says: string;
  /** scripts/<name>.mjs that prove it without a model. */
  checks: string[];
  /** e2e specs that walk it in a browser. */
  e2e?: string[];
  /** evals/cases ids that must pass on every run. */
  cases?: string[];
  /** Known to fall short until a decision is made: said on the scorecard, never hidden. */
  open?: string;
};

export const CRITICAL: readonly Critical[] = [
  {
    id: "metrics",
    says: "Numbers are counted over every row, never a page or a snapshot",
    checks: ["check-store-query", "check-store-metrics", "check-rto-cohorts", "check-stock-cover"],
    cases: ["q-cod-pending", "q-owed", "q-week-vs-week"],
  },
  {
    id: "no-duplicates",
    says: "A retry or a second press never writes twice",
    checks: ["check-build-once", "check-row-asks"],
  },
  {
    id: "corrections",
    says: "A correction is used in a fresh chat, and the old fact is retired",
    checks: ["check-memory", "check-team-facts"],
    cases: ["f-blank-rename", "m-policy"],
  },
  {
    id: "restart",
    says: "A turn cut off is finished where it was asked, or tried again by one click",
    checks: ["check-chat-stream"],
    e2e: ["e2e/retry.spec.ts"],
  },
  {
    id: "roles",
    says: "A teammate, or their own AI, cannot do what only the owner may",
    checks: ["check-row-asks", "check-team", "check-oauth-writes"],
  },
  {
    id: "tenants",
    says: "One account never reads another's store",
    checks: ["check-rls", "check-rto-cohorts", "check-stock-cover"],
  },
  {
    id: "no-deletes-refunds",
    says: "Deleting data, refunds and cancellations are never Luke's or their AI's to do",
    checks: ["check-parity", "check-store-action-propose"],
  },
  {
    id: "no-ads-stock",
    says: "Ad budgets and Shopify stock are never changed on Luke's own say",
    checks: ["check-store-send", "check-store-actions"],
    open: "Per-kind auto-send (0195) lets an owner send stock changes without a yes each time: the sprint says stock is never autonomous. The owner's decision.",
  },
  {
    id: "onboarding-chat",
    says: "The first chat opens without waiting on the store's import",
    checks: [],
    e2e: ["e2e/meet.spec.ts"],
    cases: ["m-informed", "m-discovery"],
  },
  {
    id: "dashboard-exit",
    says: "Going to the store works at once, from the first screen, in any words",
    checks: [],
    e2e: ["e2e/meet.spec.ts"],
    cases: ["m-exit", "m-exit-hinglish"],
  },
];

/** The sprint's bar: 90% of runs end to end. */
export const COMPLETION = 0.9;

/** The p-th percentile of a list, nearest rank; 0 for none. */
export function percentile(ns: number[], p: number): number {
  if (!ns.length) return 0;
  const sorted = ns.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export type Scorecard = {
  runs: number;
  passed: number;
  /** Runs that must pass for the bar: 68 of 75. */
  needed: number;
  /** Critical cases that failed on any run, as id#run. */
  criticalMisses: string[];
  byKind: Array<{ kind: string; runs: number; passed: number; p50_s: number; p95_s: number; cost: number }>;
  failed: Array<{ id: string; run: number; why: string }>;
  cost: number;
  ok: boolean;
};

/** What a set of eval runs says against the bar. */
export function scorecard(results: Array<CaseResult & { repeat?: number }>): Scorecard {
  const passed = results.filter((r) => casePassed(r)).length;
  const needed = Math.ceil(results.length * COMPLETION);
  const critical = new Set(CRITICAL.flatMap((c) => c.cases ?? []));
  const criticalMisses = results
    .filter((r) => critical.has(r.id) && !casePassed(r))
    .map((r) => `${r.id}#${r.repeat ?? 1}`);
  const kinds = [...new Set(results.map((r) => r.kind ?? "build"))].toSorted();
  const byKind = kinds.map((kind) => {
    const of = results.filter((r) => (r.kind ?? "build") === kind);
    return {
      kind,
      runs: of.length,
      passed: of.filter((r) => casePassed(r)).length,
      p50_s:
        Math.round(
          percentile(
            of.map((r) => r.ms),
            50
          ) / 100
        ) / 10,
      p95_s:
        Math.round(
          percentile(
            of.map((r) => r.ms),
            95
          ) / 100
        ) / 10,
      cost: Math.round(of.reduce((n, r) => n + r.cost, 0) * 100) / 100,
    };
  });
  const failed = results
    .filter((r) => !casePassed(r))
    .map((r) => ({
      id: r.id,
      run: r.repeat ?? 1,
      why:
        (r.checks ?? []).find((x) => !x.ok)?.name ??
        r.criteria.find((x) => !x.met)?.text ??
        r.must_not.find((x) => x.hit)?.text ??
        "nothing graded",
    }));
  return {
    runs: results.length,
    passed,
    needed,
    criticalMisses,
    byKind,
    failed,
    cost: Math.round(results.reduce((n, r) => n + r.cost, 0) * 100) / 100,
    ok: results.length > 0 && passed >= needed && criticalMisses.length === 0,
  };
}

/** The scorecard as the page Tanish and the team read: what held, what did not, what is still open. */
export function scorecardMarkdown(
  label: string,
  checks: Array<{ name: string; ok: boolean }>,
  card: Scorecard | null
): string {
  const ran = new Map(checks.map((c) => [c.name, c.ok]));
  const mark = (ok: boolean | undefined) => (ok === undefined ? "not run" : ok ? "pass" : "FAIL");
  const lines = [
    `# Acceptance: ${label}`,
    "",
    "## The ten critical scenarios",
    "",
    "| Scenario | Checks | Browser | Eval cases | Open |",
    "| --- | --- | --- | --- | --- |",
    ...CRITICAL.map((c) => {
      const caseMisses = card
        ? card.criticalMisses.filter((m) => (c.cases ?? []).some((id) => m.startsWith(`${id}#`)))
        : [];
      return `| ${c.says} | ${c.checks.map((n) => `${n}: ${mark(ran.get(n))}`).join(", ") || "-"} | ${(c.e2e ?? []).join(", ") || "-"} | ${
        c.cases?.length
          ? card
            ? caseMisses.length
              ? `FAIL ${caseMisses.join(", ")}`
              : "pass every run"
            : "not run"
          : "-"
      } | ${c.open ?? ""} |`;
    }),
    "",
  ];
  if (!card) {
    lines.push("## Eval runs", "", "Not run: the paid part waits for a budget (`--max-usd`).");
    return lines.join("\n");
  }
  lines.push(
    "## Eval runs",
    "",
    `${card.passed} of ${card.runs} runs passed end to end; the bar is ${card.needed}. Critical cases missed: ${card.criticalMisses.length ? card.criticalMisses.join(", ") : "none"}. Spent $${card.cost}. **${card.ok ? "Met" : "Not met"}.**`,
    "",
    "| Kind | Runs | Passed | p50 | p95 | Cost |",
    "| --- | --- | --- | --- | --- | --- |",
    ...card.byKind.map((k) => `| ${k.kind} | ${k.runs} | ${k.passed} | ${k.p50_s}s | ${k.p95_s}s | $${k.cost} |`),
    "",
    "## Failed runs",
    "",
    ...(card.failed.length ? card.failed.map((f) => `- ${f.id} (run ${f.run}): ${f.why}`) : ["None."])
  );
  return lines.join("\n");
}
