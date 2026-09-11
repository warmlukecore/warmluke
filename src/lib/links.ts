// ─────────────────────────────────────────────────────────────
// A link column stores the linked row's id. Everything the owner
// sees — the dropdown, the cell, the board card — needs a readable
// label for that row, and nobody should have to configure one.
// ─────────────────────────────────────────────────────────────

import type { RecordRow, SchemaColumn, UiSchema } from "./types";

/**
 * The field a linked row is named by: the first text-ish column. That
 * is almost always the human name of the thing (order number, customer
 * name, product), and picking it automatically means one less knob for
 * the assistant to get wrong.
 */
export function labelFieldFor(schema: UiSchema | null | undefined): string | null {
  const cols = schema?.columns ?? [];
  const preferred = cols.find((c) => c.type === "text" || c.type === "barcode");
  return (preferred ?? cols[0])?.field ?? null;
}

/** How a linked row reads in a dropdown or a cell. */
export function labelForRow(row: RecordRow, schema: UiSchema | null | undefined): string {
  const field = labelFieldFor(schema);
  const value = field ? row.data?.[field] : null;
  const text = value === null || value === undefined ? "" : String(value).trim();
  // Falling back to the id keeps a row pickable even when its name is
  // blank, rather than showing an empty option.
  return text || `(row ${row.id.slice(0, 8)})`;
}

export function isLink(col: SchemaColumn): boolean {
  return col.type === "link";
}
