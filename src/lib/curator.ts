// The curator (4c, 5 Oct): a kept build, put in words as an example for
// other stores (lib/examples.ts). Its shape only: what the owner asked,
// with anything that could name a person, a number or an order of theirs
// taken out, and what was built, said the way a card says it. An
// administrator reads and edits each one before Luke ever does (the
// console's What stuck); nothing here decides.
//
// Callers: src/app/[gate]/what-stuck. Pure, and safe in the browser.

import { describePlan } from "./describe";
import type { AssistantPlan } from "./types";

/** Anything in the owner's words that could name someone or something of theirs, taken out. */
export function scrubAsk(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "a link")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "an email")
    .replace(/\+?\d[\d\s-]{8,}\d/g, "a phone")
    .replace(/#\s?\d+/g, "#order")
    .replace(/\b\d{4,}\b/g, "a number")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** The plans a design reply carries: a card's, or a blueprint's. */
export function plansOf(payload: unknown): AssistantPlan[] {
  const p = payload as { plans?: unknown; blueprint?: { plans?: unknown } } | null;
  const plans = Array.isArray(p?.plans) ? p.plans : Array.isArray(p?.blueprint?.plans) ? p.blueprint.plans : [];
  return plans.filter((x): x is AssistantPlan => !!x && typeof x === "object" && "changeType" in x);
}

const SAYS_NOTHING = new Set(
  "the and for with that this from have want need karna karne chahiye hain hota hota hai jaata jaate main mujhe mera meri kuch sab kaise".split(
    " "
  )
);

/** A kept build as an example to propose; null when there is not enough to say. */
export function exampleFromBuild(
  asked: string | null,
  payload: unknown
): { ask: string; design: string; tags: string[] } | null {
  const plans = plansOf(payload);
  const ask = scrubAsk(asked ?? "");
  if (plans.length === 0 || ask.length < 10) return null;
  const design = plans
    .map((pl) => {
      const d = describePlan(pl, []);
      return [d.title, ...d.lines].filter(Boolean).join("; ");
    })
    .join(". ")
    .slice(0, 1500);
  if (design.length < 20) return null;
  const tags = [
    ...new Set(
      ask
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length >= 4 && !SAYS_NOTHING.has(w))
    ),
  ].slice(0, 8);
  return { ask, design, tags };
}
