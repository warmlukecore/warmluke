// A design used as the merchant will use it, before they see it (5 Oct).
//
// The reviewers each read one part: the critic the ask, the data check the
// values a filter, rule or counter leans on, the dry-run the rules, the
// screen check a written screen. None of them uses the section. This does,
// with the app's own functions on the rows it will meet: the store's real
// rows, or the rows the design seeds into a new section. The row form's
// dropdowns have something to choose (lib/filters optionsFor), a link has
// rows to pick and says what picking one fills in (lib/links), a worked-out
// column and a counter come out as something, a button shows on a row and
// what it writes can be worked out, a scan has codes to match, the dates
// a section opens on hold rows, a board or calendar has the field it is
// drawn by. A concrete break is a problem, which goes back to Luke; what
// only might be is a note on the card. Nothing is written and no model is
// asked. The tryout's first layer: scenarios from the owner's words, and
// the built screen walked in a browser, come after it.
//
// Callers: src/lib/review-gate.ts, scripts/check-tryout.mjs.

import { evalExpr, truthy, withComputed } from "@/lib/expr";
import { optionsFor } from "@/lib/filters";
import { fillFromLinked } from "@/lib/links";
import { inPeriod, openingPick, periodRange } from "@/lib/period";
import { STORE_TABLES, isStoreTable, storeSectionColumns, type StoreTable } from "@/lib/store-read";
import { findSection } from "@/lib/section-ref";
import { mergeFeatures, type AssistantPlan, type FeatureSchema, type SchemaColumn, type ViewSpec } from "@/lib/types";
import type { ReviewContext, TryFinding } from "@/lib/review-types";
import { count, inBudget, nodes, readSection, sectionFor, txt, type Row, type Section } from "@/lib/dry-run";
import { describeForScenarios, playDay, rulesFor, writeScenarios, type Played } from "@/lib/scenarios";

/** A section as the design leaves it, with the rows it will meet. */
export type TrySection = {
  plan: number;
  name: string;
  columns: SchemaColumn[];
  features: FeatureSchema;
  rows: Row[];
  /** Its columns that are the store's own, which the merchant never edits. */
  storeFields: Set<string>;
  /** Fields this design adds, which no row can hold yet. */
  fresh: Set<string>;
};

/** What a link points at: its name, columns and rows. */
export type TryTarget = { name: string; columns: SchemaColumn[]; rows: Row[]; store: boolean };

/** What the tryout came to: how many parts were tried, what broke or might, what picking a linked row fills, and the owner's work played. */
export type Tryout = {
  tried: number;
  found: TryFinding[];
  fills: string[];
  /** The scenarios that could be tried: through, or stopped by the design. */
  scenarios?: Array<Omit<Played, "ok" | "notes"> & { ok: boolean }>;
};

const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && !v.trim()) || (typeof v === "number" && Number.isNaN(v));

const a = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

/** Every field an expression reads. */
const reads = (e: unknown) =>
  nodes(e)
    .map((n) => n.field)
    .filter((f): f is string => typeof f === "string");

/**
 * Each part of one section tried on its rows. Pure: the rows and the link
 * targets are handed in.
 */
export function tryParts(
  s: TrySection,
  targetOf: (linkTo: string) => TryTarget | null,
  opts: { timeZone: string; locale: string; now?: Date }
): Tryout {
  const found: TryFinding[] = [];
  const fills: string[] = [];
  let tried = 0;
  const n = s.rows.length;
  const label = (f: string) => s.columns.find((c) => c.field === f)?.label ?? f;
  const say = (text: string, severity: TryFinding["severity"]) => found.push({ plan: s.plan, text, severity });
  const has = (f: string) => s.rows.some((r) => !blank(r[f]));
  // A field no row can hold yet says nothing about the design, either way.
  const knowable = (f: string) => n > 0 && !s.fresh.has(f);
  const of = `${count(n, opts.locale)} ${s.name} row${n === 1 ? "" : "s"}`;

  // The row form: a status or a choice offers something to pick.
  for (const c of s.columns) {
    if ((c.type !== "badge" && c.type !== "dropdown") || c.compute || s.storeFields.has(c.field)) continue;
    tried++;
    if (
      optionsFor(
        c.field,
        s.features,
        s.rows.map((data) => ({ data }))
      ).length === 0
    )
      say(
        `In the row form, ${c.label} has nothing to choose: no choices are set for it and no row holds one.`,
        "problem"
      );
  }

  // A link: rows to pick, and what picking one fills in.
  for (const c of s.columns) {
    if (c.type !== "link" || !c.linkTo) continue;
    const t = targetOf(c.linkTo);
    if (!t) continue;
    tried++;
    if (t.rows.length === 0) {
      say(
        t.store
          ? `The ${c.label} link offers nothing to pick: ${t.name} has no rows.`
          : `The ${c.label} link offers nothing to pick until a row is added to ${t.name}.`,
        t.store ? "problem" : "note"
      );
      continue;
    }
    const sample = t.rows[0];
    const { filled } = fillFromLinked(
      s.columns,
      Object.fromEntries(s.columns.map((x) => [x.field, ""])),
      c,
      { id: txt(sample.id) || "row", data: sample },
      t.columns
    );
    const named = Object.keys(filled).map(label);
    if (named.length) fills.push(`Picking ${a(c.label)} fills ${named.join(", ")}`);
  }

  // A worked-out column comes out as something, and from something: the
  // expressions read a blank as nothing (lib/expr), so a column worked out
  // from fields no row has shows 0 on every row, as if it were an answer.
  for (const c of s.columns) {
    if (!c.compute || !knowable(c.field)) continue;
    const inputs = [...new Set(reads(c.compute).filter((f) => f !== c.field))];
    if (inputs.some((f) => s.fresh.has(f))) continue;
    tried++;
    const results = s.rows.map((r) => withComputed(s.columns, r)[c.field]);
    if (inputs.length && !inputs.some(has)) {
      const shown = results.find((v) => !blank(v));
      say(
        `${c.label} is worked out from ${inputs.map(label).join(" and ")}, blank on all ${of}${
          shown === undefined ? "" : `: it shows ${txt(shown)} on every row`
        }.`,
        "note"
      );
    } else if (results.every(blank)) say(`${c.label} works out blank on every one of the ${of}.`, "problem");
  }

  // A counter counts or adds up something.
  for (const st of s.features.stats ?? []) {
    const value = st.value ?? (st.field ? { field: st.field } : null);
    const needs = [...reads(st.where), ...reads(value), ...(st.by ? [st.by] : [])];
    if (n === 0 || needs.some((f) => s.fresh.has(f))) continue;
    tried++;
    const rows = s.rows.filter((r) => !st.where || truthy(evalExpr(st.where, r)));
    if (rows.length === 0) {
      say(`The '${st.label}' counter counts no row yet: none of the ${of} meets its condition.`, "note");
      continue;
    }
    const by = st.by;
    if (by && !rows.some((r) => !blank(r[by]))) {
      say(`The '${st.label}' counter groups by ${label(by)}, which is blank on every row it counts.`, "problem");
      continue;
    }
    if (st.op !== "count" && value) {
      const nums = rows.map((r) => Number(evalExpr(value, r))).filter((x) => Number.isFinite(x));
      if (nums.length === 0)
        say(
          `The '${st.label}' counter adds up nothing: ${reads(value).map(label).join(", ") || "its value"} is not a number on any row it counts.`,
          "problem"
        );
    }
  }

  // A button shows on a row, what it writes can be worked out, and pressing it settles the row.
  for (const act of s.features.actions ?? []) {
    if (n === 0 || [...reads(act.when), ...Object.keys(act.set ?? {})].some((f) => s.fresh.has(f))) continue;
    tried++;
    const shown = s.rows.filter((r) => !act.when || truthy(evalExpr(act.when, r)));
    if (shown.length === 0) {
      say(`The '${act.label}' button shows on none of the ${of} yet.`, "note");
      continue;
    }
    const row = shown[0];
    let after: Row;
    try {
      after = { ...row, ...Object.fromEntries(Object.entries(act.set ?? {}).map(([f, e]) => [f, evalExpr(e, row)])) };
    } catch {
      say(`Pressing '${act.label}' cannot work out what it writes.`, "problem");
      continue;
    }
    if (act.when && truthy(evalExpr(act.when, withComputed(s.columns, after))))
      say(`Pressing '${act.label}' leaves the button on the same row: it never shows the row is done.`, "note");
  }

  // A scan has codes to match.
  const scan = s.features.scanMode;
  if (scan && knowable(scan.lookupField)) {
    tried++;
    const fields = [scan.lookupField, ...(scan.alsoMatch ?? [])];
    if (!fields.some(has))
      say(`A scan matches nothing: ${fields.map(label).join(" and ")} is blank on all ${of}.`, "problem");
  }

  // The order rows open in.
  const sort = s.features.defaultSort;
  if (sort && knowable(sort.field) && s.columns.some((c) => c.field === sort.field)) {
    tried++;
    if (!has(sort.field)) say(`Rows open in order of ${label(sort.field)}, which is blank on every row.`, "note");
  }

  // The dates it opens on hold rows.
  const period = s.features.period;
  if (period && knowable(period.field)) {
    tried++;
    if (!has(period.field)) {
      say(
        `Its dates are read from ${label(period.field)}, which is blank on all ${of}: every window shows nothing.`,
        "problem"
      );
    } else {
      const range = periodRange(period.field, openingPick(period), opts.timeZone, opts.now);
      if (range && !s.rows.some((r) => inPeriod(r[period.field], range)))
        say(
          `It opens on the last ${period.default} days of ${label(period.field)}, and none of the ${of} falls in them: it would open empty.`,
          "problem"
        );
    }
  }

  // A board, calendar, cards or list view has the field it is drawn by.
  const views = [s.features.view, ...(s.features.tabs ?? [])].filter((v): v is ViewSpec => !!v);
  for (const v of views) {
    const by =
      v.type === "board"
        ? { field: v.groupBy, what: "groups its columns by", severity: "problem" as const }
        : v.type === "calendar"
          ? { field: v.dateField, what: "puts rows on days by", severity: "problem" as const }
          : v.type === "cards" || v.type === "list"
            ? { field: v.titleField, what: "names each row by", severity: "note" as const }
            : null;
    if (!by || !knowable(by.field)) continue;
    tried++;
    if (!has(by.field)) say(`The ${v.type} ${by.what} ${label(by.field)}, which is blank on all ${of}.`, by.severity);
  }

  return { tried, found, fills };
}

/** The changes that alter how a section is used: what the tryout tries. */
const SHAPES = new Set(["NEW_MODULE", "UI_CHANGE", "FIELD_ADD", "FEATURE_UPDATE"]);

/** A section this design makes, as a list of one to find it by its "#slug". */
const asMade = (p: AssistantPlan) => [{ id: "", name: p.newModule!.name, nav_label: p.newModule!.nav_label }];

/**
 * The design tried: each section it makes or changes, on the rows it will
 * meet, within the review's time.
 */
export async function tryDesign(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  opts: {
    /** Whose days "the last N days" are: the shop's (MCP passes it, having no store context). */
    zone?: string;
    /** The model that writes the owner's work as scenarios (lib/scenarios.ts); none, the parts alone. */
    scenarios?: string | null;
  } = {}
): Promise<Tryout> {
  const zone = opts.zone ?? ctx.store?.timezone ?? "UTC";
  const tried: Array<{ s: TrySection; isThis: (ref: string | null) => boolean }> = [];
  const out: Tryout = { tried: 0, found: [], fills: [] };
  await inBudget<null>(ctx, async () => {
    // Rows read once a section, for the sections tried and the ones they link to.
    const rowsOf = new Map<string, Promise<Row[]>>();
    const read = (at: Section) => {
      if (!rowsOf.has(at.mod.id))
        rowsOf.set(
          at.mod.id,
          readSection(ctx, at).then((r) => r.rows)
        );
      return rowsOf.get(at.mod.id)!;
    };
    // A section this design makes: its columns, and the rows it will open on.
    const made = async (p: AssistantPlan) => {
      const table = isStoreTable(p.newModule?.source_table) ? (p.newModule!.source_table as StoreTable) : null;
      const columns = table ? storeSectionColumns(table, p.newSchema?.columns) : (p.newSchema?.columns ?? []);
      let rows: Row[] = [];
      if (table) {
        // The store's rows, read through a section already over the same list.
        const over = ctx.modules.find((m) => m.source_table === table);
        const at = over ? sectionFor(ctx, plans, over.id) : null;
        if (at && "mod" in at) rows = await read(at);
      } else rows = (p.newRecords ?? []).map((r) => withComputed(columns, r));
      return { table, columns, rows };
    };

    const targets = new Map<string, TryTarget | null>();
    const target = async (linkTo: string) => {
      if (targets.has(linkTo)) return;
      const at = sectionFor(ctx, plans, linkTo);
      let t: TryTarget | null = null;
      if (at && "mod" in at) t = { name: at.name, columns: at.columns, rows: await read(at), store: !!at.table };
      else if (at) {
        const p = plans.find((x) => x.changeType === "NEW_MODULE" && x.newModule && findSection(asMade(x), linkTo));
        if (p) {
          const m = await made(p);
          t = { name: p.newModule!.nav_label || p.newModule!.name, columns: m.columns, rows: m.rows, store: !!m.table };
        }
      }
      targets.set(linkTo, t);
    };

    // Each section once, as the design leaves it: its last columns, and every change to its features laid over.
    const seen = new Set<string>();
    for (const [i, p] of plans.entries()) {
      if (!SHAPES.has(p.changeType)) continue;
      let s: TrySection | null = null;
      let isThis = (ref: string | null) => !!ref && !!p.newModule && !!findSection(asMade(p), ref);
      if (p.changeType === "NEW_MODULE" && p.newModule) {
        const key = `#${p.newModule.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const m = await made(p);
        const ours = new Set(m.table ? STORE_TABLES[m.table].columns.map((c) => c.field) : []);
        const later = plans.filter(
          (x) => x.changeType === "FEATURE_UPDATE" && x.targetModuleId && findSection(asMade(p), x.targetModuleId)
        );
        s = {
          plan: i,
          name: p.newModule.nav_label || p.newModule.name,
          columns: m.columns,
          features: later.reduce((f, x) => mergeFeatures(f, x.features), mergeFeatures(null, p.features)),
          rows: m.rows,
          storeFields: ours,
          // Over the store, the merchant's own fields are new; a section of their own opens on the rows it seeds.
          fresh: new Set(m.table ? m.columns.map((c) => c.field).filter((f) => !ours.has(f)) : []),
        };
      } else if (p.targetModuleId) {
        const at = sectionFor(ctx, plans, p.targetModuleId);
        if (!at || !("mod" in at) || seen.has(at.mod.id)) continue;
        isThis = (ref) => !!ref && !!findSection([at.mod], ref);
        seen.add(at.mod.id);
        const changes = plans.filter(
          (x) => x.changeType === "FEATURE_UPDATE" && x.targetModuleId && findSection([at.mod], x.targetModuleId)
        );
        s = {
          plan: i,
          name: at.name,
          columns: at.columns,
          features: changes.reduce(
            (f, x) => mergeFeatures(f, x.features),
            ctx.schemas.get(at.mod.id)?.features ?? ({} as FeatureSchema)
          ),
          rows: await read(at),
          storeFields: new Set(at.table ? STORE_TABLES[at.table].columns.map((c) => c.field) : []),
          fresh: at.fresh,
        };
      }
      if (!s) continue;
      tried.push({ s, isThis });
      for (const c of s.columns) if (c.type === "link" && c.linkTo) await target(c.linkTo);
      const got = tryParts(s, (l) => targets.get(l) ?? null, { timeZone: zone, locale: ctx.locale });
      out.tried += got.tried;
      out.found.push(...got.found);
      out.fills.push(...got.fills);
    }

    // The owner's own work, written as scenarios and played on what was read.
    if (!opts.scenarios || !ctx.ownerWords.trim() || tried.length === 0) return;
    const targetOf = (l: string) => targets.get(l) ?? null;
    const withRules = tried.map((t) => ({ ...t, rules: rulesFor(plans, t.isThis) }));
    const written = await writeScenarios({
      ownerWords: ctx.ownerWords,
      understood: ctx.understood,
      sections: withRules.map((t) => describeForScenarios(t.s, targetOf, t.rules)),
      model: opts.scenarios,
      signal: ctx.signal,
    });
    const played = playDay(withRules, written, targetOf);
    for (const p of played) {
      if (p.ok === false) out.found.push({ plan: p.plan, text: `Tried "${p.title}": ${p.why}`, severity: "problem" });
      for (const n of p.notes ?? []) out.found.push({ plan: p.plan, text: n, severity: "note" });
    }
    // What was tried: a scenario that could not be, its own mistake, is left out.
    const done = played.filter((p) => p.ok !== null);
    if (done.length) out.scenarios = done.map(({ title, section, ok, why }) => ({ title, section, ok: !!ok, why }));
  });
  return out;
}
