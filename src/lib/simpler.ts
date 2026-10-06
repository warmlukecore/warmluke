// The simpler build that does the same job, said once (6 Oct).
//
// The simplicity reviewer sends a design back for missing these, the
// merchant's own AI is told them when it connects (lib/client-guide), and
// Luke reads them before it designs (lib/ai replyContract), so the first
// attempt is already the simple one. Its own module so lib/ai can read it
// without importing the reviewer, which imports lib/ai.
//
// Callers: src/lib/reviewers.ts, src/lib/client-guide.ts, src/lib/ai.ts.

/**
 * The simpler build that does the same job, each "this instead of that":
 * what the reviewer sends a design back for, what the merchant's own AI
 * is told when it connects (lib/client-guide) and what Luke reads before
 * it designs, from this one list, so the three never drift apart.
 */
export const SIMPLER_WAYS = [
  "the field the section already has instead of a second one meaning the same",
  "one status instead of several ticks for one fact",
  "a rule that fires when a row changes, or a blank that already reads as not set, instead of a schedule that rewrites every row",
  "the section's own table, a filter, a stat or a row's pop-up instead of a written screen that only shows rows",
  "one view instead of a second tab of the same rows",
  "a field on the store's own rows instead of a copy list",
  "a table with a link column to the other section (the store's orders and their items too) instead of a written screen that picks a row there and writes one: choosing a linked row in the row form fills the fields of the same name, and a second link to its items offers that row's items alone",
];

/** When a written screen is the right build after all: read with SIMPLER_WAYS, by the same two. */
export const REAL_WORK =
  "A written screen that takes scans the owner asked for, steps through work or does what no table can is not a workaround. A scan box only to find the one row to pick is not that: a scanner types into a link's search the same.";
