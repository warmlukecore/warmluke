// What was just built, tried on the store's real data before anyone is
// told it is done (12 Oct).
//
// Luke calls it after a build (test_build, lib/verify-tool.ts), and so can
// the owner's own AI (MCP test_build). It reuses the checks a design passes
// before its card (lib/review-gate), now on what was saved:
// - the rules on the rows they would meet (lib/dry-run): expressions worked
//   out, a change tried as if it had just happened, code run as its runs
//   will run it, nothing written;
// - each section used as the merchant will (lib/tryout): worked-out
//   columns, counters, filters, links, buttons, dates, boards;
// - the values they lean on, read against the rows (lib/data-check);
// - each written screen's sections, looked up, and its code, read.
// What comes back is short and honest: what stops it working, with the
// evidence, and what is true but not broken ("changed nothing today").
// What it was meant to do comes back beside it, for Luke to compare.
//
// No model and no write. The caller's own client, so RLS decides what is
// read. A bigger app is bounded by each check's own time budget.
//
// Callers: src/lib/verify-tool.ts, src/app/api/mcp/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sectionsRead } from "@/lib/ai";
import { customViewProblem } from "@/lib/custom-view";
import { checkAgainstData } from "@/lib/data-check";
import { dryRunRules, type CodeTry } from "@/lib/dry-run";
import { schemasFor } from "@/lib/engine";
import { projectFormat } from "@/lib/money";
import { findSection } from "@/lib/section-ref";
import { tryDesign, type Tryout } from "@/lib/tryout";
import type { DesignChecks, DryRun, ReviewContext } from "@/lib/review-types";
import type { Scenario } from "@/lib/scenarios";
import type { AssistantPlan, AutomationDefinition, FeatureSchema, ModuleRow, ViewSpec } from "@/lib/types";

/** What to test, by name or id; left out, what was built in the last hour. */
export type Built = { sections?: string[]; rules?: string[] };

export type TestResult = {
  /** Nothing found that stops it working. */
  ok: boolean;
  /** One line to say: "Tested on your data: …". */
  said: string;
  /** What stops it working, each with what showed it. */
  problems: string[];
  /** What is so but not broken: changed nothing today, could not be tried here. */
  notes: string[];
  /** Each rule, and what it did on their rows. */
  rules: Array<{ rule: string; section: string; result: string; problem?: string }>;
  tested: { rules: number; sections: number; parts: number };
  /** What it was meant to do, as the caller said it: theirs to hold the result against. */
  expected?: string;
  /** The checks the owner agreed to, played again on what was built: each through or not. */
  checks?: Array<{ title: string; section: string; ok: boolean; why?: string }>;
};

/** A check the owner agreed to, as kept on the design it was played on: played again after the build. */
export type GivenCheck = Scenario & { agreed?: boolean };

/** "What was built" when nobody names it. */
const LATELY_MS = 60 * 60 * 1000;
/** The most of either a test takes on: past it, the newest. */
const MOST = 12;

const plan = (over: Partial<AssistantPlan>): AssistantPlan => ({
  changeType: "FEATURE_UPDATE",
  targetModuleId: null,
  newModule: null,
  newSchema: { columns: [] },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
  ...over,
});

/** A tried rule in words: what it did, or why it was not counted. */
function ruleWords(d: DryRun): string {
  if (d.matched === null) return d.note ?? "could not be told without running it";
  const counted = d.of === null ? `${d.matched} rows` : `${d.matched} of ${d.of} ${d.section} rows`;
  return d.note ? `${counted}. ${d.note}` : counted;
}

/** The written screens of a section: its view, and its tabs. */
function screensOf(f: FeatureSchema | null | undefined): Array<Extract<ViewSpec, { type: "custom" }>> {
  const views = [f?.view, ...((f as { tabs?: ViewSpec[] } | undefined)?.tabs ?? [])];
  return views.filter((v): v is Extract<ViewSpec, { type: "custom" }> => v?.type === "custom");
}

/**
 * Tries what was built on the store's real data. `built` names the
 * sections and rules (any name or id they go by); left out, the ones made
 * or changed in the last hour. `expectation` is what it should do, in the
 * caller's words, handed back beside the result.
 */
export async function testBuild(
  db: SupabaseClient,
  projectId: string,
  built: Built = {},
  expectation?: string,
  use?: CodeTry,
  /** The design's agreed checks, with their steps: played again on what was saved. */
  given: GivenCheck[] = []
): Promise<TestResult> {
  const [{ data: mods }, { data: project }, { data: store }, { data: autos }] = await Promise.all([
    db.from("modules").select("*").eq("project_id", projectId),
    db.from("projects").select("locale, currency, currency_set_by_user").eq("id", projectId).maybeSingle(),
    db.from("stores").select("timezone, currency, country").eq("project_id", projectId).maybeSingle(),
    db
      .from("automations")
      .select("id, name, module_id, enabled, definition, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
  ]);
  const modules = (mods ?? []) as ModuleRow[];
  const schemas = await schemasFor(db, modules);
  const money = projectFormat(project, store);
  const named = (refs: string[] | undefined) => (refs ?? []).map((r) => r.trim()).filter(Boolean);
  const since = Date.now() - LATELY_MS;

  // The rules: as named, or the ones made lately.
  type Rule = {
    id: string;
    name: string;
    module_id: string;
    enabled: boolean;
    definition: AutomationDefinition;
    created_at: string;
  };
  const all = (autos ?? []) as Rule[];
  const wantRules = named(built.rules);
  const rules = (
    wantRules.length
      ? all.filter((r) => wantRules.some((w) => w === r.id || w.toLowerCase() === r.name.toLowerCase()))
      : built.sections?.length
        ? []
        : all.filter((r) => Date.parse(r.created_at) >= since)
  ).slice(0, MOST);

  // The sections: as named, the ones those rules sit on, or the ones changed lately.
  const wantSections = named(built.sections);
  const sections = new Map<string, ModuleRow>();
  for (const ref of wantSections) {
    const m = findSection(modules, ref) ?? modules.find((x) => x.nav_label.toLowerCase().includes(ref.toLowerCase()));
    if (m) sections.set(m.id, m);
  }
  for (const r of rules) {
    const m = modules.find((x) => x.id === r.module_id);
    if (m) sections.set(m.id, m);
  }
  if (!wantSections.length && !wantRules.length) {
    const { data: lately } = await db
      .from("ui_schemas")
      .select("module_id")
      .in(
        "module_id",
        modules.map((m) => m.id)
      )
      .gte("created_at", new Date(since).toISOString());
    for (const row of (lately ?? []) as Array<{ module_id: string }>) {
      const m = modules.find((x) => x.id === row.module_id);
      if (m) sections.set(m.id, m);
    }
  }
  const tested = [...sections.values()].slice(0, MOST);
  const missing = [
    ...wantSections.filter(
      (ref) => !findSection(modules, ref) && !modules.some((x) => x.nav_label.toLowerCase().includes(ref.toLowerCase()))
    ),
    ...wantRules.filter((w) => !all.some((r) => w === r.id || w.toLowerCase() === r.name.toLowerCase())),
  ];
  const notes: string[] = missing.map((m) => `Nothing called "${m}" is in this app.`);
  for (const r of rules) if (!r.enabled) notes.push(`The rule "${r.name}" is turned off: tried as if it were on.`);
  if (!rules.length && !tested.length) {
    return {
      ok: true,
      said: "Nothing to test: nothing was built in the last hour, and nothing was named.",
      problems: [],
      notes,
      rules: [],
      tested: { rules: 0, sections: 0, parts: 0 },
      ...(expectation ? { expected: expectation } : {}),
    };
  }

  const ctx: ReviewContext = {
    db,
    projectId,
    store: null,
    modules,
    schemas,
    ownerWords: expectation ?? "",
    understood: "",
    locale: money.locale,
    currency: money.currency,
    uxModel: null,
  };
  const rulePlans = rules.map((r) =>
    plan({
      changeType: "AUTOMATION_ADD",
      targetModuleId: r.module_id,
      automation: { name: r.name, definition: r.definition },
    })
  );
  const sectionPlans = tested.map((m) => plan({ targetModuleId: m.id, features: {} as FeatureSchema }));
  const [ran, used, leaned] = await Promise.all([
    rulePlans.length ? dryRunRules(ctx, rulePlans, use) : Promise.resolve([] as DryRun[]),
    sectionPlans.length
      ? tryDesign(ctx, sectionPlans, { zone: (store?.timezone as string | undefined) ?? "UTC", scenarios: null, given })
      : Promise.resolve<Tryout>({ tried: 0, found: [], fills: [] }),
    checkAgainstData(ctx, [...rulePlans, ...sectionPlans]),
  ]);

  const problems: string[] = [];
  for (const d of ran) if (d.problem) problems.push(`Rule "${d.rule}": ${d.problem}`);
  for (const f of used.found) (f.severity === "problem" ? problems : notes).push(f.text);
  for (const f of leaned) (f.severity === "problem" ? problems : notes).push(f.text);
  let screens = 0;
  for (const m of tested) {
    for (const v of screensOf(schemas.get(m.id)?.features)) {
      screens++;
      const why = customViewProblem(v.html);
      if (why) problems.push(`The screen "${v.title}" on ${m.nav_label}: ${why}`);
      for (const ref of sectionsRead(v.html))
        if (!findSection(modules, ref))
          problems.push(`The screen "${v.title}" on ${m.nav_label} reads ${ref}, which is no section of this app now.`);
    }
  }

  const parts = ran.length + used.tried + screens;
  const ruleLines = ran.map((d) => ({
    rule: d.rule,
    section: d.section,
    result: ruleWords(d),
    ...(d.problem ? { problem: d.problem } : {}),
  }));
  const counted = [
    rules.length ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"}` : null,
    tested.length ? `${tested.length} ${tested.length === 1 ? "section" : "sections"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return {
    ok: problems.length === 0,
    said: problems.length
      ? `Tested on your data (${counted}): ${problems.length} ${problems.length === 1 ? "thing stops" : "things stop"} it working. ${problems[0]}`
      : `Tested on your data (${counted}): nothing found that stops it working.${ruleLines[0] ? ` ${ruleLines[0].rule}: ${ruleLines[0].result}` : ""}`,
    problems: problems.slice(0, 8),
    notes: [...new Set(notes)].slice(0, 8),
    rules: ruleLines,
    tested: { rules: rules.length, sections: tested.length, parts },
    ...(expectation ? { expected: expectation } : {}),
    ...(used.scenarios?.length
      ? { checks: used.scenarios.map(({ title, section, ok, why }) => ({ title, section, ok, why })) }
      : {}),
  };
}

/** The agreed checks a design was played on, with their steps, from its reply's kept checks. */
export function givenFrom(checks: DesignChecks | null | undefined): GivenCheck[] {
  return (checks?.tryout?.scenarios ?? [])
    .filter((s) => s.agreed && Array.isArray(s.steps) && s.steps.length > 0)
    .map((s) => ({ title: s.title, section: s.section, steps: s.steps!, agreed: true }));
}

/** What the test said of a build, kept on the build's own line in the thread, with the agreed checks played again. */
export type Tested = {
  ok: boolean;
  said: string;
  problems: string[];
  checks?: Array<{ title: string; section: string; ok: boolean; why?: string }>;
};

/**
 * After a build: what it made or changed, tried on the store's real data,
 * and what came of it kept on the build's own line, for the card to say
 * and offer to fix (12 Oct). The step between "built" and "done": a rule
 * that changes nothing it should is said here, not found by the owner a
 * day later. Runs after the answer has gone; never throws.
 *
 * Callers: src/app/api/apply/route.ts.
 */
export async function testAfterBuild(db: SupabaseClient, projectId: string, messageId: string): Promise<void> {
  try {
    const { data: line } = await db.from("messages").select("payload").eq("id", messageId).maybeSingle();
    if (!line) return;
    // The design this build came from: the checks its owner agreed to, kept on it, are played again.
    const designId = (line.payload as { design?: unknown } | null)?.design;
    const { data: design } =
      typeof designId === "string"
        ? await db.from("messages").select("payload").eq("id", designId).maybeSingle()
        : { data: null };
    const given = givenFrom((design?.payload as { checks?: DesignChecks } | null)?.checks);
    // Nothing named: what was made or changed in the last hour, this build with it.
    const result = await testBuild(db, projectId, {}, undefined, undefined, given);
    if (!result.tested.rules && !result.tested.sections) return;
    const tested: Tested = {
      ok: result.ok,
      said: result.said,
      problems: result.problems.slice(0, 4),
      ...(result.checks ? { checks: result.checks } : {}),
    };
    await db
      .from("messages")
      .update({ payload: { ...(line.payload as Record<string, unknown>), tested } })
      .eq("id", messageId);
  } catch (e) {
    console.error(`[tested] ${e instanceof Error ? e.message : "failed"}`);
  }
}
