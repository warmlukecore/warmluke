// The reviewers after the critic, as one gate.
//
// The critic asks whether a design does what was asked. Four more
// questions are asked of it here, at once: is there a simpler build
// (reviewers.ts), do the values it leans on exist in the store's own rows
// (data-check.ts), what would its rules do to the rows they meet
// (dry-run.ts), and do its screens hold up on a phone and a laptop
// (ux-review.ts). What they find comes back as one line to the designer,
// or none, and as the checks the design's card shows. The engine sends a
// design back at most once a turn, critic and gate together.
//
// It never throws: a reviewer that fails, or is switched off, is no
// reviewer, and the design goes on as it would have without it.
//
// Callers: src/lib/engine.ts (runTurn), scripts/check-reviewers.mjs.

import { reviewModel, tryoutModel } from "@/lib/ai";
import { checkAgainstData } from "@/lib/data-check";
import { dryRunRules } from "@/lib/dry-run";
import { simplicityReview, workaroundSigns, type SimplicityVerdict } from "@/lib/reviewers";
import { reviewScreens } from "@/lib/ux-review";
import { tryDesign, type Tryout } from "@/lib/tryout";
import type { DataFinding, DesignChecks, DryRun, ReviewContext, UxVerdict } from "@/lib/review-types";
import type { AssistantPlan, TurnEvent } from "@/lib/types";

/** The most the gate's line to the designer holds: enough to act on, never a second contract. */
export const REDO_MAX = 1200;

/** Checks with nothing in them. */
export const noChecks = (): DesignChecks => ({ simplicity: null, data: [], dryRuns: [], ux: null, tryout: null });

/** Whether the reviewers said anything a card could show: with every switch off they say nothing, and the reply is as it was. */
export const hasChecks = (c: DesignChecks | null | undefined): c is DesignChecks =>
  !!c && (!!c.simplicity || c.data.length > 0 || c.dryRuns.length > 0 || !!c.ux || (c.tryout?.tried ?? 0) > 0);

/** A rule that runs on a schedule and writes the same value into every row it sets: what "would rewrite all N rows" means. */
function writesConstantOnSchedule(plan: AssistantPlan | undefined): boolean {
  const def = plan?.automation?.definition;
  if (def?.trigger?.type !== "schedule") return false;
  const sets = (def.actions ?? []).filter((a) => a.type === "set_fields");
  return (
    sets.length > 0 &&
    sets.every((a) => {
      const values = Object.values(a.set ?? {});
      return values.length > 0 && values.every((v) => !!v && typeof v === "object" && "const" in v);
    })
  );
}

/**
 * What goes back to the designer, from what the reviewers found, or null
 * when nothing needs fixing. Each part under a short header; the whole
 * cut to REDO_MAX. Notes and passes are for the card, never sent back.
 */
export function redoFrom(
  found: {
    simplicity: SimplicityVerdict | null;
    data: DataFinding[];
    dryRuns: DryRun[];
    ux: UxVerdict | null;
    /** Sent back only with the review's switch on: off, a recorded conversation must play as it was recorded. */
    tryout?: Tryout | null;
  },
  plans: AssistantPlan[]
): string | null {
  const parts: string[] = [];
  const broke = (found.tryout?.found ?? []).filter((f) => f.severity === "problem");
  if (broke.length) parts.push(`Used as they will use it:\n${broke.map((f) => `- ${f.text}`).join("\n")}`);
  if (found.simplicity?.verdict === "redo" && found.simplicity.redo) parts.push(`SIMPLER: ${found.simplicity.redo}`);
  const problems = found.data.filter((f) => f.severity === "problem");
  if (problems.length) {
    parts.push(`Checked against their own rows:\n${problems.map((f) => `- ${f.text}`).join("\n")}`);
  }
  const rewrites = found.dryRuns.filter((d) => d.everyRow && writesConstantOnSchedule(plans[d.plan]));
  if (rewrites.length) {
    parts.push(
      `Tried on their rows:\n${rewrites
        .map(
          (d) =>
            `- Rule "${d.rule}" would rewrite all ${d.of ?? d.matched ?? "the"} rows of ${d.section} every run, writing the same value each time`
        )
        .join("\n")}`
    );
  }
  if (found.ux?.verdict === "redo" && found.ux.fix) {
    parts.push(
      `The screen, looked at: ${found.ux.fix}${
        found.ux.issues.length
          ? `\n${found.ux.issues
              .slice(0, 3)
              .map((i) => `- ${i}`)
              .join("\n")}`
          : ""
      }`
    );
  }
  if (parts.length === 0) return null;
  const all = parts.join("\n\n");
  return all.length > REDO_MAX ? `${all.slice(0, REDO_MAX - 1)}…` : all;
}

/** Runs one reviewer; one that fails says so in the log and is no reviewer. */
async function quietly<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    console.error(`[review] ${what}: ${e instanceof Error ? e.message : "failed"}`);
    return null;
  }
}

/**
 * The reviewers on one design, at once, each told as it lands: the
 * simplicity reviewer (when its setting is on), the data check, the rule
 * dry-run and the screen review. A step is told only when its reviewer
 * said something, so a switched-off one is never claimed.
 */
export async function reviewDesign(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  opts: { tell: (s: TurnEvent) => void; describe: string; columnLines: string[] }
): Promise<{ redo: string | null; checks: DesignChecks }> {
  const tell = (s: TurnEvent) => {
    try {
      opts.tell(s);
    } catch {
      /* the caller's problem, not the review's */
    }
  };
  try {
    const review = reviewModel();
    const [simplicity, data, dryRuns, ux, tryout] = await Promise.all([
      review
        ? quietly("simplicity", async () => {
            const v = await simplicityReview({
              ownerWords: ctx.ownerWords,
              understood: ctx.understood,
              built: opts.describe,
              columnLines: opts.columnLines,
              signs: workaroundSigns(plans, ctx.modules, ctx.schemas),
              model: review,
              signal: ctx.signal,
            });
            if (v) tell({ step: "simplicity", verdict: v.verdict });
            return v;
          })
        : null,
      quietly("data", async () => {
        const f = await checkAgainstData(ctx, plans);
        const problems = f.filter((x) => x.severity === "problem").length;
        if (f.length) tell({ step: "data", problems, notes: f.length - problems });
        return f;
      }),
      quietly("dry-run", async () => {
        const d = await dryRunRules(ctx, plans);
        if (d.length) {
          const known = d.every((x) => x.matched !== null);
          tell({
            step: "dryrun",
            rules: d.length,
            matched: known ? d.reduce((s, x) => s + (x.matched ?? 0), 0) : null,
          });
        }
        return d;
      }),
      quietly("screens", async () => {
        const u = await reviewScreens(ctx, plans);
        if (u.verdict !== "skipped") tell({ step: "ux", verdict: u.verdict, how: u.how });
        return u;
      }),
      quietly("tryout", async () => {
        const t = await tryDesign(ctx, plans, { scenarios: tryoutModel() });
        if (t.tried)
          tell({ step: "tryout", tried: t.tried, problems: t.found.filter((f) => f.severity === "problem").length });
        return t;
      }),
    ]);
    const found = {
      simplicity,
      data: data ?? [],
      dryRuns: dryRuns ?? [],
      ux: ux && ux.verdict !== "skipped" ? ux : null,
      tryout: review ? tryout : null,
    };
    return {
      redo: redoFrom(found, plans),
      checks: {
        simplicity: simplicity ? { verdict: simplicity.verdict, why: simplicity.why || null } : null,
        data: found.data,
        dryRuns: found.dryRuns,
        ux: found.ux,
        tryout: tryout && tryout.tried > 0 ? tryout : null,
      },
    };
  } catch (e) {
    console.error(`[review] ${e instanceof Error ? e.message : "failed"}`);
    return { redo: null, checks: noChecks() };
  }
}
