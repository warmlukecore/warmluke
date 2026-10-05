// Designs that worked (4b, 5 Oct): how a similar ask was solved well, read
// by the plan step and the design call beside the owner's words, so Luke
// starts from a shape that works rather than from nothing. Not a gallery
// the merchant picks from: Luke still designs for this owner, their rows
// and their words; an example only says what a good answer looked like.
//
// The seeds are ours, on problems none of the evals ask about (evals/cases:
// COD confirmation, low stock, repeat buyers, returns, RTO), so an eval
// still measures designing and not remembering. Kept designs join them
// once the admin approves (4c, design_examples): their shape only, never
// a store's rows, names or customers.
//
// Callers: lib/engine.ts (plan and design prompts). Pure but for approvedExamples.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SEED_EXAMPLES, type DesignExample } from "./example-seeds";
import { wordsOf } from "./learning";

export { SEED_EXAMPLES, type DesignExample } from "./example-seeds";

/** At least this many words in common before an example is said to bear on an ask. */
const MIN_OVERLAP = 2;
/** Words nearly every store's ask has: they say nothing about which work it is ("flag orders from customers" is not a review request). */
const EVERY_STORE = new Set([
  "order",
  "customer",
  "product",
  "store",
  "shop",
  "item",
  "track",
  "karne",
  "chahiye",
  "process",
  "app",
]);
const workWords = (text: string) => new Set([...wordsOf(text)].filter((w) => !EVERY_STORE.has(w)));

/** The examples nearest an ask, best first; none when nothing is near enough. */
export function examplesFor(message: string, extra: DesignExample[] = [], max = 2): DesignExample[] {
  const asked = workWords(message);
  if (asked.size === 0) return [];
  return [...extra, ...SEED_EXAMPLES]
    .map((e) => {
      const theirs = workWords(`${e.ask} ${e.tags.join(" ")}`);
      return { e, overlap: [...asked].filter((w) => theirs.has(w)).length };
    })
    .filter((x) => x.overlap >= MIN_OVERLAP)
    .toSorted((a, b) => b.overlap - a.overlap)
    .slice(0, max)
    .map((x) => x.e);
}

/** The block the plan step and the design call read; "" when no example bears on the ask. */
export function describeExamples(examples: DesignExample[]): string {
  if (examples.length === 0) return "";
  return [
    "",
    "DESIGNS THAT WORKED — how a similar ask was solved well for another store. Learn the shape: which rows it built on, how little it added, what the owner presses and what runs by itself. Fit it to THIS owner's words, rows and sections; never copy a field, a choice or a rule that their ask does not need.",
    ...examples.map((e) => `- They said: "${e.ask}"\n  Built: ${e.design}\n  Why this shape: ${e.why}`),
  ].join("\n");
}

/** Kept designs an administrator approved (0181), as Luke reads them; [] on a database without them. */
export async function approvedExamples(db: SupabaseClient): Promise<DesignExample[]> {
  try {
    const { data, error } = await db.rpc("abo_design_examples");
    if (error || !Array.isArray(data)) return [];
    return (data as Array<{ id: string; ask: string; design: string; why: string | null; tags: string[] | null }>).map(
      (e) => ({ id: e.id, ask: e.ask, design: e.design, why: e.why ?? "", tags: e.tags ?? [] })
    );
  } catch {
    return [];
  }
}
