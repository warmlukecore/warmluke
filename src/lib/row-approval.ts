// A row's button that waits for the owner's yes (#6, 5 Oct). A button
// marked "approval" (a refund, a discount, a cancellation) does its change
// at once when the owner presses it; a teammate's press waits in the
// owner's bell (0183). For that to mean anything, a teammate cannot make
// the same change by hand either: an edit that would do what such a
// button does is refused at the door (lib/record-write.ts), with the
// button to press instead.
//
// What a button does to a row is worked out here, the way the screen does
// it (components/views.tsx ActionButtons): its "when" on the row, then its
// "set". Callers: lib/record-write.ts, app/api/row-action. Pure.

import { evalExpr, truthy, withComputed } from "./expr";
import type { FeatureSchema, SchemaColumn } from "./types";

export type RowAction = NonNullable<FeatureSchema["actions"]>[number];

const same = (a: unknown, b: unknown) =>
  String(a ?? "")
    .trim()
    .toLowerCase() ===
  String(b ?? "")
    .trim()
    .toLowerCase();

/** What a button does to this row, worked out from it; null when it does not show on the row. */
export function actionOn(
  action: RowAction,
  columns: SchemaColumn[],
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const r = withComputed(columns, row);
  if (action.when !== undefined && !truthy(evalExpr(action.when, r))) return null;
  return Object.fromEntries(Object.entries(action.set).map(([f, e]) => [f, evalExpr(e, r)]));
}

/**
 * The approval button whose change this edit would make by hand: a field
 * it sets, set to what it would set it to, from what the row held before.
 * Null when the edit makes no such change, or there is no such button.
 */
export function approvalNeededFor(
  features: FeatureSchema | null | undefined,
  columns: SchemaColumn[],
  previous: Record<string, unknown>,
  data: Record<string, unknown>
): string | null {
  for (const a of features?.actions ?? []) {
    if (!a.approval) continue;
    const would = actionOn(a, columns, previous);
    if (!would) continue;
    const makes = Object.entries(would).some(([f, v]) => f in data && same(data[f], v) && !same(previous[f], v));
    if (makes) return a.label;
  }
  return null;
}

/** The row as the owner will know it in the bell: its first two fields that say something. */
export const rowLabel = (columns: SchemaColumn[], row: Record<string, unknown>) =>
  columns
    .filter((c) => !c.hidden && c.type !== "link" && c.type !== "boolean")
    .map((c) => row[c.field])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .slice(0, 2)
    .map((v) => String(v).slice(0, 50))
    .join(" · ");

/** A section's button by its label, as the screen shows it. */
export const actionNamed = (features: FeatureSchema | null | undefined, label: string) =>
  (features?.actions ?? []).find((a) => a.label === label) ?? null;

/** One row of row_approvals, as the bell and the tools read it. */
export type AskRow = {
  id: string;
  module_id: string;
  kind: string | null;
  batch: string | null;
  action: string;
  row_label: string;
  summary: string | null;
  asked_via: string | null;
  asked_at: string;
};

export type Ask = {
  /** The batch, or the one row's id for a teammate's press. */
  id: string;
  batch: string | null;
  module_id: string;
  what: string;
  rows: number;
  asked_by: "Luke" | "their own AI" | "a teammate";
  asked_at: string;
};

/** Waiting rows as asks: one per batch, one per teammate's press. */
export function groupAsks(rows: AskRow[]): Ask[] {
  const by = new Map<string, Ask>();
  for (const r of rows) {
    const key = r.batch ?? r.id;
    const had = by.get(key);
    if (had) {
      had.rows++;
      continue;
    }
    by.set(key, {
      id: key,
      batch: r.batch,
      module_id: r.module_id,
      what: r.summary ?? `“${r.action}” on ${r.row_label ? `“${r.row_label}”` : "a row"}`,
      rows: 1,
      asked_by: r.asked_via === "luke" ? "Luke" : r.asked_via === "mcp" ? "their own AI" : "a teammate",
      asked_at: r.asked_at,
    });
  }
  return [...by.values()];
}
