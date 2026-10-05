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

// ─────────────────────────────────────────────────────────────
// Choosing a linked row fills the form from it, and narrows the next
// link to it (5 Oct). Worked out from the sections themselves, never
// configured: an order chosen on a return fills its customer and phone,
// and the return's item is then one of that order's items. The owner's
// own typing is never written over.
// ─────────────────────────────────────────────────────────────

/** A linked row as a form fills from it: its id and every field it holds. */
export type LinkedRow = { id: string; data: Record<string, unknown> };

/**
 * Fields a row keeps about itself, never about what it links to: a
 * return's status is not its order's. Left for the owner however they
 * are named alike.
 * ponytail: a fixed list of names; a column flag the designer sets, if
 * a store's own words for these turn up.
 */
const OWN_STATE = new Set([
  "status",
  "state",
  "stage",
  "note",
  "notes",
  "comment",
  "comments",
  "remark",
  "remarks",
  "reason",
  "description",
]);

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** A linked row's value in a field's own type, or undefined when it does not fit one. */
function asType(col: SchemaColumn, v: unknown, options: string[] | null): unknown {
  if (empty(v)) return undefined;
  switch (col.type) {
    case "number":
    case "currency": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "date": {
      const s = String(v);
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "badge":
    case "dropdown": {
      // Only a choice the field already has: an order's "Paid" is no return status.
      const s = String(v).trim();
      return options && options.includes(s) ? s : undefined;
    }
    case "link":
      return undefined;
    default:
      return typeof v === "object" ? undefined : String(v);
  }
}

/**
 * What choosing a linked row fills in, the rest of the form left as the
 * owner has it. A field is filled when it is empty, or still holds what
 * the last pick of this link put there; never one they typed. It takes
 * the row's field of the same key, else of the same label; a computed
 * column, a link, a field a row keeps about itself (OWN_STATE) and the
 * link itself are never filled, and a value that does not fit the
 * field's type is left out. An empty value on the row clears nothing.
 */
export function fillFromLinked(
  columns: SchemaColumn[],
  draft: Record<string, unknown>,
  link: SchemaColumn,
  row: LinkedRow,
  /** The linked section's columns, so a field can be matched by its label too. */
  sourceColumns: SchemaColumn[],
  /** What the last pick of this link filled: field -> value. */
  previous: Record<string, unknown> = {},
  /** A badge or dropdown field's fixed choices; null when it has none. */
  optionsOf: (field: string) => string[] | null = () => null
): { draft: Record<string, unknown>; filled: Record<string, unknown> } {
  const next = { ...draft };
  const filled: Record<string, unknown> = {};
  const byKey = new Map(Object.keys(row.data).map((k) => [norm(k), k]));
  const byLabel = new Map(sourceColumns.map((c) => [norm(c.label), c.field]));
  for (const col of columns) {
    if (col.field === link.field || col.compute || OWN_STATE.has(norm(col.field))) continue;
    const current = draft[col.field];
    // The owner's own: something there that the last pick did not put there.
    if (!empty(current) && !(col.field in previous && previous[col.field] === current)) continue;
    const from = byKey.get(norm(col.field)) ?? byLabel.get(norm(col.label)) ?? byKey.get(norm(col.label));
    if (!from) continue;
    const value = asType(col, row.data[from], optionsOf(col.field));
    if (value === undefined) continue;
    next[col.field] = value;
    filled[col.field] = value;
  }
  // What the last pick filled and this one does not reach is cleared, unless the owner changed it.
  for (const [f, v] of Object.entries(previous)) if (!(f in filled) && next[f] === v) next[f] = "";
  return { draft: next, filled };
}

/** A section a link points at, as narrowing reads it. */
export type LinkTarget = {
  /** The store list it shows, when it is over one. */
  table: string | null;
  /** Its parent lists by column ("order_id" -> "orders"), when it is over one. */
  parents: Record<string, string>;
  columns: SchemaColumn[];
};

/**
 * The rows a link may offer, narrowed by another link already chosen in
 * the same form: the order's items once the order is picked. A store
 * list names its parent by "<thing>_id"; a section of theirs points at
 * one with a link column. Null when nothing narrows it, and then every
 * row is offered.
 */
export function narrowFor(
  link: SchemaColumn,
  columns: SchemaColumn[],
  draft: Record<string, unknown>,
  targetOf: (moduleId: string) => LinkTarget | null
): { field: string; value: string } | null {
  if (!link.linkTo) return null;
  const target = targetOf(link.linkTo);
  if (!target) return null;
  for (const other of columns) {
    if (other === link || other.type !== "link" || !other.linkTo || other.linkTo === link.linkTo) continue;
    const chosen = draft[other.field];
    if (empty(chosen)) continue;
    const parent = targetOf(other.linkTo);
    if (!parent) continue;
    // A store list under the chosen one's store list: an order's items.
    if (target.table && parent.table) {
      const field = Object.keys(target.parents).find((f) => target.parents[f] === parent.table);
      if (field) return { field, value: String(chosen) };
    }
    // A section of theirs that links to the chosen one's section.
    const via = target.columns.find((c) => c.type === "link" && c.linkTo === other.linkTo);
    if (via) return { field: via.field, value: String(chosen) };
  }
  return null;
}
