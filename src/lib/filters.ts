// Matching a dropdown against the rows it is supposed to filter.
//
// The options on a filter are written by the assistant when it
// designs a section. The values in the rows come from somewhere else
// entirely — Shopify, or whatever somebody typed. Nothing has ever
// made the two agree, and when they disagree the dropdown looks
// broken: it opens, it has options, and every one of them shows
// nothing.
//
// That is exactly what happened to a products section. The filter
// offered "active / draft / archived"; Shopify stores ACTIVE, DRAFT
// and ARCHIVED. Selecting one matched zero rows out of twenty-one.
//
// A number or an amount is filtered by a range instead (filterKind),
// here, in the store's page and in the stat cards alike (0194).
//
// Callers: src/components/GenericRenderer.tsx, src/components/RecordModal.tsx (optionsFor), src/lib/tryout.ts,
// src/lib/store-read.ts, src/lib/screen.ts, src/lib/view-edit.ts, the validator in src/lib/ai.ts.

export type RecordRow = { data?: Record<string, unknown> | null };

/** How a value is compared: the way a person reads it, not the bytes. */
const key = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

/**
 * The things one cell names. A tag list is not one value.
 *
 * Shopify tags arrive as an array and are joined for display, so the
 * cell reads "Premium, Snow, Winter" — one string as far as anything
 * downstream can tell. Filtering it whole meant "Winter" matched
 * nothing, and the only option that ever matched was the entire list
 * typed back exactly.
 *
 * ponytail: splits on the comma, so a free-text field that happens to
 * contain one ("Mumbai, MH") is offered as two choices. Both still
 * find the row; if a field ever needs its commas left alone, the
 * column type is what should say so.
 */
const parts = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => String(x ?? "")) : String(v ?? "").split(",")).map((s) => s.trim()).filter(Boolean);

/** A tick, however it was stored: true, "true", "yes" or 1. */
export const isYes = (v: unknown) => v === true || v === 1 || ["true", "yes"].includes(key(v));

/**
 * A yes/no field is a tick: on, or not. Its choices are always these two,
 * and "No" is every row not ticked, blank or false alike. Offered the
 * values in the data, an RTO filter read Yes, No, true, false, and "No"
 * found none of the rows nobody had marked (Tanish, 3 Oct).
 */
export const YES_NO = ["Yes", "No"];

/**
 * How a filter asks, by its column: a tick is Yes or No; a number or an
 * amount is a range, a lowest and a highest, either left open ("price
 * between ₹500 and ₹2,000"), since a list of every price is no choice;
 * anything else is one of its values.
 */
export type FilterKind = "choice" | "yesno" | "range";
export const filterKind = (type: string | undefined): FilterKind =>
  type === "boolean" ? "yesno" : type === "number" || type === "currency" || type === "percent" ? "range" : "choice";

/** A range: the lowest and the highest, either left open. */
export type Range = { min?: number; max?: number };

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v ?? "")
    .replace(/^(rs\.?|inr)\s*/i, "")
    .replace(/[,\s₹$€£%]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A range, as the bar keeps it ("500..2000", "500..", "..2000") or as a
 * model or a link gives it ({ "min": 500, "max": 2000 }). Null when it
 * names neither end.
 */
export function readRange(v: unknown): Range | null {
  let min: unknown;
  let max: unknown;
  if (v && typeof v === "object" && !Array.isArray(v)) ({ min, max } = v as Record<string, unknown>);
  else if (typeof v === "string" && v.includes("..")) [min, max] = v.split("..");
  else return null;
  const r: Range = {};
  if (num(min) !== undefined) r.min = num(min);
  if (num(max) !== undefined) r.max = num(max);
  return r.min === undefined && r.max === undefined ? null : r;
}

/** A range as the bar keeps it: "" when it names neither end. */
export const rangeText = (r: Range | null) => (r ? `${r.min ?? ""}..${r.max ?? ""}` : "");

/** A value inside a range: a blank or a word is in none, not 0. */
export function inRange(value: unknown, r: Range | null): boolean {
  if (!r) return true;
  const n = num(value);
  return n !== undefined && (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max);
}

/**
 * Does this row belong under this choice?
 *
 * Case and stray spaces are not what a merchant means by a category.
 * The search box beside these filters has always matched this way;
 * only the filters were comparing byte for byte.
 */
export function matchesFilter(
  row: RecordRow,
  field: string,
  chosen: string,
  kind: FilterKind | boolean = "choice"
): boolean {
  const value = row.data?.[field];
  if (kind === "range") return inRange(value, readRange(chosen));
  const want = key(chosen);
  if (kind === true || kind === "yesno") return isYes(value) === (want === "yes");
  // The whole cell first, for a choice that is itself a list — an
  // option designed before this, or a value with a comma in its name.
  return key(value) === want || parts(value).some((p) => key(p) === want);
}

/**
 * The choices to offer, from what was designed AND what is there.
 *
 * Declared options alone leave a section unusable when the data
 * disagrees. The data alone leaves a new, empty section with an empty
 * dropdown — and the point of designing options up front is to say
 * what rows are meant to be filed under.
 *
 * So: both, deduplicated by meaning rather than by spelling, and
 * where the two forms differ the one in the data wins — that is the
 * one the merchant can see in the column beside it.
 */
export function filterOptions(declared: string[], rows: RecordRow[], field: string, yesNo = false): string[] {
  if (yesNo) return YES_NO;
  const out: string[] = [];
  const seen = new Map<string, number>();

  for (const option of declared) {
    const k = key(option);
    if (!k || seen.has(k)) continue;
    seen.set(k, out.length);
    out.push(option);
  }

  for (const row of rows) {
    // A blank is not a category. Rows without one are still reachable
    // through "All", which is what an unset filter means — and a cell
    // holding three tags offers three choices, not one made of all of
    // them.
    for (const value of parts(row.data?.[field])) {
      const k = key(value);
      const at = seen.get(k);
      if (at === undefined) {
        seen.set(k, out.length);
        out.push(value);
      } else if (out[at] !== value) {
        // Same meaning, different spelling. Show the merchant's own.
        out[at] = value;
      }
    }
  }

  return out;
}

/**
 * Choices for a badge/dropdown field: whatever the assistant configured
 * as a filter, plus every value already in use. Derived, so a field
 * nobody configured still offers the values the owner actually types.
 */
export function optionsFor(
  field: string,
  features: { filters?: Array<{ field: string; options: string[] }> } | null,
  records: Array<{ data?: Record<string, unknown> | null }>
): string[] {
  const configured = features?.filters?.find((f) => f.field === field)?.options ?? [];
  const seen = new Set<string>(configured);
  for (const r of records) {
    const v = r.data?.[field];
    if (typeof v === "string" && v.trim()) seen.add(v.trim());
  }
  return [...seen];
}
