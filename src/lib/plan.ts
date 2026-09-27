// What Luke understood, before it designs.
//
// The design call used to do everything at once: understand the
// owner's problem, decide what to build, and write it in the grammar
// the validator reads — eleven thousand tokens of rules in front of it
// the whole time. The plan step comes first and carries none of that
// grammar: in a short prompt (the talk road's), the model says in
// words what the owner is after, which rows it works on, what happens
// to a row, what has to be recorded, which rules, which screens, and
// what it is not sure of. Those words go into the design call's user
// turn. A plan that does not parse is no plan: the design goes on as
// it always did.
//
// Callers: src/lib/engine.ts (runTurn), scripts/check-plan.mjs.

import { stripFences } from "@/lib/ai";

export type DesignIntent = {
  /** One line: the outcome the owner wants, in their words. */
  goal: string;
  /** Which rows this works on: a store list, a section by name, or new rows of its own. */
  rows: string;
  /** What happens to a row, in order. */
  work: string[];
  /** What has to be recorded on a row, in words, not field types. */
  facts: string[];
  /** When this, then that — in words. */
  rules: string[];
  /** What the owner sees or does, and where. */
  screens: string[];
  /** What Luke could not settle from the words: each a candidate question. */
  unsure: string[];
};

const words = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

/** The model's reply as an intent, or null when it is not one. */
export function parseIntent(raw: string): DesignIntent | null {
  let o: unknown;
  try {
    o = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const goal = typeof r.goal === "string" ? r.goal.trim().slice(0, 240) : "";
  if (!goal) return null;
  return {
    goal,
    rows: typeof r.rows === "string" ? r.rows.trim().slice(0, 300) : "",
    work: words(r.work, 8),
    facts: words(r.facts, 12),
    rules: words(r.rules, 8),
    screens: words(r.screens, 6),
    unsure: words(r.unsure, 4),
  };
}

const list = (label: string, items: string[]) =>
  items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";

/** The intent as the block the design call reads, after the owner's request. */
export function intentBlock(intent: DesignIntent): string {
  const lines = [
    `WHAT LUKE UNDERSTOOD — design from this. Where it says "unsure", ask (clarify) or pick the likelier one and say so in "message":`,
    `Goal: ${intent.goal}`,
    intent.rows ? `Rows: ${intent.rows}` : "",
    list("Work", intent.work),
    list("Record", intent.facts),
    list("Rules", intent.rules),
    list("Screens", intent.screens),
    list("Unsure", intent.unsure),
  ];
  // A blank line first: it follows the owner's own words in the same turn.
  return `\n\n${lines.filter((l) => l !== "").join("\n")}`;
}
