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
// Callers: src/components/GenericRenderer.tsx.

export type RecordRow = { data?: Record<string, unknown> | null };

/** How a value is compared: the way a person reads it, not the bytes. */
const key = (v: unknown) => String(v ?? "").trim().toLowerCase();

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
  (Array.isArray(v) ? v.map((x) => String(x ?? "")) : String(v ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Does this row belong under this choice?
 *
 * Case and stray spaces are not what a merchant means by a category.
 * The search box beside these filters has always matched this way;
 * only the filters were comparing byte for byte.
 */
export function matchesFilter(row: RecordRow, field: string, chosen: string): boolean {
  const value = row.data?.[field];
  const want = key(chosen);
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
export function filterOptions(declared: string[], rows: RecordRow[], field: string): string[] {
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
