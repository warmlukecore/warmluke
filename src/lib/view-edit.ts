// Changing how a section looks, without designing anything (5 Oct).
//
// Renaming a column, taking one off the table, putting them in another
// order, choosing the filters and the order rows open in: none of it
// needs a model, and asking Luke for it cost a turn and a minute (Tanish:
// "removing a column is just editing the view"). The owner does it with
// Customize, their own AI with edit_view over MCP; both come here, and
// what comes out is the same two plans Luke would have sent (UI_CHANGE,
// FEATURE_UPDATE), so the validator, the version history and undo treat
// it as any other change. Nothing about a section's columns is assumed:
// what can be a filter is read off the column's type and the values its
// rows hold.
//
// Callers: src/components/ViewEditor.tsx, src/app/api/mcp/route.ts,
// scripts/check-view-edit.mjs.

import { filterKind, YES_NO } from "@/lib/filters";
import type { AssistantPlan, FeatureSchema, SchemaColumn, UiSchema } from "@/lib/types";

export type Sort = { field: string; dir: "asc" | "desc" };
export type Filter = NonNullable<FeatureSchema["filters"]>[number];

export type ViewEdit = {
  /** Columns in the order to show them, each with its name and whether it is on the table. One left out keeps its place after these. */
  columns?: Array<{ field: string; label?: string; hidden?: boolean }>;
  /** The fields to filter by, in order: the whole list, [] for none. */
  filters?: string[];
  /** The order rows open in; null for the order they came in. */
  sort?: Sort | null;
};

/** As many choices as a filter offers: past this it is a list to scroll, not a filter (the validator's limit too). */
export const MAX_CHOICES = 15;

/**
 * The choices a filter on this column offers, or why it can offer none.
 * A tick is Yes / No by itself; a number or an amount is a lowest and a
 * highest (lib/filters filterKind), with no list; a status keeps the
 * choices it was given and adds what its rows hold; a word column is a
 * filter only while its rows hold a few values, not a different one each.
 */
export function filterChoices(
  col: SchemaColumn,
  kept: string[] | undefined,
  values: string[]
): { options: string[]; range?: true } | { why: string } {
  if (col.type === "boolean") return { options: [...YES_NO] };
  if (filterKind(col.type) === "range") return { options: [], range: true };
  if (col.type !== "badge" && col.type !== "dropdown" && col.type !== "text")
    return { why: `"${col.label}" is not a column of choices, so a filter has nothing to list` };
  const seen = [...new Set([...(kept ?? []), ...values].map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (seen.length < 2)
    return { why: `"${col.label}" needs two different values in its rows before it can be a filter` };
  // A word column is a choice only while its values come round again: a
  // different one on each row (an order number, a name) is no filter, at
  // three rows or three thousand. One already a filter keeps its place.
  const given = values.filter((v) => String(v ?? "").trim()).length;
  if (col.type === "text" && !kept?.length && (seen.length > MAX_CHOICES || seen.length * 2 > given))
    return { why: `"${col.label}" holds a different value on almost every row, so there is nothing to choose between` };
  return { options: seen.slice(0, MAX_CHOICES) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether two column lists look the same on the table: the same fields in
 * the same order, each with its label, its type and whether it is shown.
 * The validator's test of a UI_CHANGE too (lib/ai), so the editor never
 * sends a change the validator calls none. Compared as text before, a
 * column rebuilt with its keys in another order read as changed, and the
 * owner who hid a column and put it back was shown the validator's own
 * words (Carefone, 6 Oct).
 */
export const sameColumns = (a: SchemaColumn[], b: SchemaColumn[]) =>
  a.length === b.length &&
  a.every((c, i) => {
    const d = b[i];
    return !!d && d.field === c.field && d.label === c.label && d.type === c.type && !d.hidden === !c.hidden;
  });

/** A filter kept for its choices and taken off the bar (a status's: see editView). */
export const filterIsOff = (f: Filter) => (f as Filter & { hidden?: boolean }).hidden === true;

/**
 * The section as it would look after the edit, with what changed in
 * words and what cannot be done. Nothing outside the edit moves: a
 * column it does not name keeps its name and place, and a filter is
 * renamed with its column only while it still carried the column's name.
 */
export function editView(
  schema: UiSchema,
  edit: ViewEdit,
  /** The values a column's rows hold, for a filter's choices. */
  valuesOf: (field: string) => string[]
): { columns: SchemaColumn[]; filters: Filter[]; sort: Sort | null; said: string[]; errors: string[] } {
  const errors: string[] = [];
  const said: string[] = [];
  const before = schema.columns;
  const was = new Map(before.map((c) => [c.field, c]));

  let columns = before;
  if (edit.columns) {
    const listed: SchemaColumn[] = [];
    for (const e of edit.columns) {
      const c = e && typeof e.field === "string" ? was.get(e.field) : undefined;
      if (!c) {
        errors.push(`There is no column "${String(e?.field)}" in this section.`);
        continue;
      }
      if (listed.some((l) => l.field === c.field)) continue;
      const label = typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, 60) : c.label;
      const hidden = typeof e.hidden === "boolean" ? e.hidden : !!c.hidden;
      const { hidden: _, ...rest } = c;
      listed.push(hidden ? { ...rest, label, hidden: true } : { ...rest, label });
    }
    columns = [...listed, ...before.filter((c) => !listed.some((l) => l.field === c.field))];
  }
  if (columns.length > 0 && columns.every((c) => c.hidden))
    errors.push("At least one column has to stay on the table.");

  for (const c of columns) {
    const old = was.get(c.field)!;
    if (old.label !== c.label) said.push(`renamed "${old.label}" to "${c.label}"`);
    if (!old.hidden && c.hidden) said.push(`took "${c.label}" off the table (it is still there when a row is opened)`);
    if (old.hidden && !c.hidden) said.push(`put "${c.label}" back on the table`);
  }
  // A new order of what was on the table and stays there, said apart from what came on or off it.
  const stays = (field: string) => !was.get(field)?.hidden && !columns.find((c) => c.field === field)?.hidden;
  const order = (cs: SchemaColumn[]) => cs.map((c) => c.field).filter(stays);
  if (!same(order(columns), order(before)))
    said.push(
      `put the columns in the order ${columns
        .filter((c) => !c.hidden)
        .map((c) => c.label)
        .join(", ")}`
    );

  const byField = new Map(columns.map((c) => [c.field, c]));
  const had = schema.features?.filters ?? [];
  let filters: Filter[] = had;
  if (edit.filters) {
    const out: Filter[] = [];
    for (const field of edit.filters) {
      const col = typeof field === "string" ? byField.get(field) : undefined;
      if (!col) {
        errors.push(`There is no column "${String(field)}" to filter by.`);
        continue;
      }
      if (out.some((f) => f.field === field)) continue;
      const old = had.find((f) => f.field === field);
      const choices = filterChoices(col, old?.options, valuesOf(field));
      if ("why" in choices) {
        errors.push(choices.why);
        continue;
      }
      const { hidden: _, ...kept } = (old ?? {}) as Filter & { hidden?: boolean };
      out.push({ ...kept, field, label: old?.label ?? col.label, options: choices.options });
    }
    // A status's filter is where the row form finds its choices
    // (RecordModal optionsFor): taken off the bar, it keeps them, or a
    // new section's form would offer nothing but the values already typed.
    for (const old of had)
      if (!out.some((f) => f.field === old.field)) {
        const col = byField.get(old.field);
        if (col && (col.type === "badge" || col.type === "dropdown") && old.options?.length)
          out.push({ ...old, hidden: true } as Filter);
      }
    filters = out;
  }
  // Renamed with its column, while it still said the column's name.
  filters = filters.map((f) => {
    const from = was.get(f.field)?.label;
    const to = byField.get(f.field)?.label;
    return from && to && from !== to && f.label === from ? { ...f, label: to } : f;
  });
  for (const f of filters)
    if (!filterIsOff(f) && !had.some((o) => o.field === f.field && !filterIsOff(o)))
      said.push(`added a filter by "${f.label}"`);
  for (const f of had)
    if (!filterIsOff(f) && !filters.some((n) => n.field === f.field && !filterIsOff(n)))
      said.push(`took the "${f.label}" filter off`);

  let sort = schema.features?.defaultSort ?? null;
  if (edit.sort !== undefined) {
    if (edit.sort === null) sort = null;
    else if (!edit.sort || !byField.has(edit.sort.field))
      errors.push(`There is no column "${String(edit.sort?.field)}" to put the rows in order by.`);
    else sort = { field: edit.sort.field, dir: edit.sort.dir === "desc" ? "desc" : "asc" };
  }
  if (!same(sort, schema.features?.defaultSort ?? null))
    said.push(
      sort
        ? `rows open in order of "${byField.get(sort.field)!.label}", ${sort.dir === "asc" ? "lowest or earliest first" : "highest or latest first"}`
        : "rows open in the order they came in"
    );

  return { columns, filters, sort, said, errors };
}

const plan = (p: Partial<AssistantPlan> & Pick<AssistantPlan, "changeType" | "targetModuleId">): AssistantPlan => ({
  newModule: null,
  newSchema: null as unknown as UiSchema,
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
  ...p,
});

/**
 * The edit as the plans that make it: a UI_CHANGE when a column changed,
 * a FEATURE_UPDATE naming only the parts that did. None when nothing
 * would change; refused, with every reason, when any part cannot be done.
 */
export function viewEditPlans(
  moduleId: string,
  schema: UiSchema,
  edit: ViewEdit,
  valuesOf: (field: string) => string[]
): { plans: AssistantPlan[]; said: string[]; errors: string[] } {
  const v = editView(schema, edit, valuesOf);
  if (v.errors.length) return { plans: [], said: [], errors: v.errors };
  const words = (s: string[]) => {
    const t = s.join("; ");
    return t.charAt(0).toUpperCase() + t.slice(1) + ".";
  };
  const plans: AssistantPlan[] = [];
  if (!sameColumns(v.columns, schema.columns))
    plans.push(
      plan({
        changeType: "UI_CHANGE",
        targetModuleId: moduleId,
        newSchema: { columns: v.columns },
        explanation: words(v.said),
      })
    );
  const features: Record<string, unknown> = {};
  if (!same(v.filters, schema.features?.filters ?? [])) features.filters = v.filters.length ? v.filters : null;
  if (!same(v.sort, schema.features?.defaultSort ?? null)) features.defaultSort = v.sort;
  if (Object.keys(features).length)
    plans.push(
      plan({
        changeType: "FEATURE_UPDATE",
        targetModuleId: moduleId,
        features: features as FeatureSchema,
        explanation: words(v.said),
      })
    );
  return { plans, said: v.said, errors: [] };
}
