// A design read against the store's own rows: does it lean on values and
// fields the rows really have?
//
// A rule for status "in transit" on rows that say "In Transit" never
// fires, and a filter choice nobody's rows carry shows nothing; both
// look right on paper, and the validator, which reads only the design,
// passes them. The rows say otherwise, so this reads them: the values in
// a rule's conditions, a filter's choices and a stat's counting, each
// field they lean on, and the field a rule matches rows in another
// section by. No model; the rows are read on the caller's own client
// (lib/dry-run readSection), so RLS decides what may be checked.
//
// Callers: src/lib/review-gate.ts.

import { evalExpr } from "@/lib/expr";
import { storeRowFields } from "@/lib/store-read";
import type { AssistantPlan, Expr, FeatureSchema } from "@/lib/types";
import type { DataFinding, ReviewContext } from "@/lib/review-types";
import {
  count,
  inBudget,
  nodes,
  readSection,
  sectionFor,
  txt,
  type Row,
  type Section,
  type SectionRows,
} from "@/lib/dry-run";

/** A field a part of the design leans on, and the value it expects there, if it names one. */
type Lean = {
  plan: number;
  at: Section;
  field: string;
  value?: string;
  /** A filter's choice, matched as filters match: ignoring case and stray spaces. */
  choice?: boolean;
};
/** A rule finding the rows it writes to in another section, by a field of theirs. */
type Match = { plan: number; from: Section; to: Expr; there: Section; field: string };

/** A value spelled the way it reads: no case, no spaces or marks, no plural, a tick as a tick. */
function near(v: string): string {
  const k = v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (k === "yes" || k === "true") return "true";
  if (k === "no" || k === "false") return "false";
  return k.length > 3 ? k.replace(/(es|s)$/, "") : k;
}

/** A literal worth looking for among the rows: words, not a number, a date or a blank. */
const wordy = (v: string) => v.trim() !== "" && Number.isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v);

/** "a status", "an order". */
const a = (w: string) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;

/** The fields an expression reads, and the words it compares a field to (= and !=, as the rule says them). */
function readsOf(e: unknown): Array<{ field: string; value?: string }> {
  const out: Array<{ field: string; value?: string }> = [];
  for (const n of nodes(e)) {
    if (typeof n.field === "string") out.push({ field: n.field });
    if ((n.op === "=" || n.op === "!=") && Array.isArray(n.args)) {
      const [x, y] = n.args as Row[];
      const field = typeof x?.field === "string" ? x.field : typeof y?.field === "string" ? y.field : null;
      const value = x && "const" in x ? x.const : y && "const" in y ? y.const : undefined;
      if (field && typeof value === "string" && wordy(value)) out.push({ field, value });
    }
  }
  return out;
}

/** What each plan leans on, and the rule matches it makes. */
function leansOf(ctx: ReviewContext, plans: AssistantPlan[]): { leans: Lean[]; matches: Match[] } {
  const leans: Lean[] = [];
  const matches: Match[] = [];
  for (const [i, plan] of plans.entries()) {
    const at = sectionFor(ctx, plans, plan.targetModuleId);
    // A section this design makes has no rows to check against yet; the dry-run says so of its rules.
    if (!at || "made" in at) continue;
    const def = plan.changeType === "AUTOMATION_ADD" ? plan.automation?.definition : null;
    if (def) {
      for (const r of readsOf(def.trigger?.when)) leans.push({ plan: i, at, ...r });
      for (const act of Array.isArray(def.actions) ? def.actions : []) {
        if (act.type !== "set_fields" || !act.target || "self" in act.target || !act.target.match) continue;
        const there = sectionFor(ctx, plans, act.target.module_id);
        if (!there || "made" in there) continue;
        const { field, to } = act.target.match;
        matches.push({ plan: i, from: at, to, there, field });
        leans.push({ plan: i, at: there, field });
        for (const r of readsOf(to)) leans.push({ plan: i, at, field: r.field });
      }
    }
    const features: FeatureSchema | null | undefined = plan.features ?? plan.newSchema?.features;
    for (const f of features?.filters ?? []) {
      // A yes/no field offers Yes and No whatever its options say (lib/filters YES_NO).
      if (!f?.field || at.columns.find((c) => c.field === f.field)?.type === "boolean") continue;
      leans.push({ plan: i, at, field: f.field });
      for (const o of f.options ?? [])
        if (typeof o === "string" && o.trim()) leans.push({ plan: i, at, field: f.field, value: o, choice: true });
    }
    for (const s of features?.stats ?? []) {
      for (const r of [...readsOf(s?.value), ...readsOf(s?.where)]) leans.push({ plan: i, at, ...r });
      for (const f of [s?.field, s?.by]) if (typeof f === "string" && f) leans.push({ plan: i, at, field: f });
    }
  }
  return { leans, matches };
}

/** A field as the owner reads it: its label where it has one. */
const labelOf = (at: Section, field: string) => at.columns.find((c) => c.field === field)?.label ?? field;

/** A field the section has: a column of it, or one the store's rows carry unshown (financial_status). */
const known = (at: Section, field: string) =>
  at.columns.some((c) => c.field === field) || (at.table !== null && storeRowFields(at.table).includes(field));

/**
 * Every value a field holds over the rows read, and over the whole list
 * where the store gave it: whole, and each part of a list.
 * ponytail: one set for both, so a rule's "=" may pass on a part of a tag
 * list it would not match whole; split them if that ever hides a miss.
 */
function valuesOf(got: SectionRows, field: string): string[] {
  const out = new Set<string>(got.facets[field] ?? []);
  for (const r of got.rows) {
    const v = r[field];
    for (const p of [...(Array.isArray(v) ? v : [v]).map(txt), ...txt(v).split(",")]) if (p.trim()) out.add(p.trim());
  }
  return [...out];
}

/**
 * What the design leans on that the rows do not have: a value spelled
 * other than the rows spell it (a problem: it will match nothing), a
 * value no row has yet (a note), a field blank on every row read (a
 * note), and a rule that matches rows in another section by values the
 * two never share (a problem). `plan` is the part's place in `plans`.
 */
export async function checkAgainstData(ctx: ReviewContext, plans: AssistantPlan[]): Promise<DataFinding[]> {
  return inBudget<DataFinding>(ctx, async (out) => {
    const { leans, matches } = leansOf(ctx, plans);
    if (!leans.length) return;

    // Each section once, asking the store for every field leaned on there.
    const wanted = new Map<string, { at: Section; fields: Set<string> }>();
    for (const l of leans) {
      const w = wanted.get(l.at.mod.id) ?? { at: l.at, fields: new Set<string>() };
      if (!l.at.columns.find((c) => c.field === l.field)?.compute) w.fields.add(l.field);
      wanted.set(l.at.mod.id, w);
    }
    const read = new Map<string, SectionRows>();
    await Promise.all(
      [...wanted.values()].map(async (w) => read.set(w.at.mod.id, await readSection(ctx, w.at, [...w.fields])))
    );

    const said = new Set<string>();
    const say = (plan: number, text: string, severity: DataFinding["severity"]) => {
      if (said.has(text)) return;
      said.add(text);
      out.push({ plan, text, severity });
    };
    for (const l of leans) {
      const got = read.get(l.at.mod.id);
      // A field this design adds, or one the section does not have (the validator's to say), has nothing to check.
      if (!got || !got.rows.length || l.at.fresh.has(l.field) || !known(l.at, l.field)) continue;
      const label = labelOf(l.at, l.field);
      const values = valuesOf(got, l.field);
      if (!values.length) {
        say(
          l.plan,
          got.rows.length === 1
            ? `${label} is blank on the only ${l.at.name} row.`
            : `${label} is blank on all ${count(got.rows.length, ctx.locale)} ${l.at.name} rows.`,
          "note"
        );
        continue;
      }
      if (l.value === undefined) continue;
      const want = l.value.trim();
      // A filter matches ignoring case and spaces (lib/filters, abo_store_page); a rule compares text exactly (lib/expr).
      if (l.choice ? values.some((v) => v.toLowerCase() === want.toLowerCase()) : values.includes(l.value)) continue;
      const close = values.find((v) => near(v) === near(want));
      if (close)
        say(l.plan, `'${l.value}' is never ${a(label.toLowerCase())} here; the rows say '${close}'.`, "problem");
      else say(l.plan, `No ${l.at.name} row has ${label} '${l.value}' yet.`, "note");
    }

    for (const m of matches) {
      const [from, there] = [read.get(m.from.mod.id), read.get(m.there.mod.id)];
      if (!from?.rows.length || !there?.rows.length || m.there.fresh.has(m.field)) continue;
      // Found by plain equal text, as the runtime finds them.
      const theirs = new Set(there.rows.map((r) => txt(r[m.field])).filter(Boolean));
      const ours = from.rows.map((r) => txt(evalExpr(m.to, r))).filter(Boolean);
      if (!theirs.size || !ours.length || ours.some((v) => theirs.has(v))) continue;
      const by = typeof (m.to as { field?: unknown }).field === "string" ? (m.to as { field: string }).field : null;
      say(
        m.plan,
        `${labelOf(m.there, m.field)} in ${m.there.name} never equals ${by ? labelOf(m.from, by) : "what the rule looks for"} on any ${m.from.name} row (the rows say '${[...theirs][0]}' and '${ours[0]}'), so the rule would find nothing to change.`,
        "problem"
      );
    }
  });
}
