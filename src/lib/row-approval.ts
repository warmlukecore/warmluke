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

/** A section's button by its label, as the screen shows it. */
export const actionNamed = (features: FeatureSchema | null | undefined, label: string) =>
  (features?.actions ?? []).find((a) => a.label === label) ?? null;
