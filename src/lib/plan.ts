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
  /**
   * The plan as the owner reads it, before anything is built: how it
   * will work, what is unclear, and "Want me to build it?". Empty for a
   * small exact change, or when they said to just build it.
   */
  say: string;
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
    say: typeof r.say === "string" ? r.say.trim().slice(0, 1500) : "",
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

/**
 * Said before it is built (Tanish, 3 Oct: "propose a plan in plain
 * English, then ask: do you want me to build it?"). In the app's own
 * chat a design is first Luke's plan in words, from the plan step, and
 * the owner's yes builds it. What was agreed is kept on that reply, so
 * the yes builds exactly that.
 */
export type Proposal = { kind: "proposal"; understood: DesignIntent };

/** The plan Luke said in the last reply, when that reply was one, read off the raw reply a thread keeps. */
export function proposalOf(history: Array<{ role: string; content: string }>): DesignIntent | null {
  const last = [...history].reverse().find((t) => t.role === "assistant")?.content ?? "";
  if (!last.includes('"proposal"')) return null;
  try {
    const r = JSON.parse(last) as { kind?: unknown; understood?: unknown };
    return r.kind === "proposal" ? parseIntent(JSON.stringify(r.understood)) : null;
  } catch {
    return null;
  }
}

/** A plain yes to a plan, in either language: nothing added that would change it. */
export function isGoAhead(message: string): boolean {
  const m = message
    .trim()
    .toLowerCase()
    .replace(/[.!🙂👍]+$/u, "");
  return (
    m.length <= 40 &&
    /^(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|build it|build|haan|han|ha|haa|haanji|ji|ji haan|theek hai|thik hai|sahi hai|chalo|karo|kar do|bana do|banao|haan karo|haan bana do|haan build karo|yes build it|yes please|ok build it|ok go ahead)( please| now| karo| kar do| bana do| ji)?$/.test(
      m
    )
  );
}

/** Asked to build without being asked anything first. */
export const wantsItBuilt = (message: string) =>
  /\b(just build( it)?|build it now|no questions|without asking|seedha bana|bas bana do|directly build|build directly)\b/i.test(
    message
  );

/** What the owner agreed to, as the design call reads it: built as said, not asked again. */
export function agreedBlock(intent: DesignIntent): string {
  return intentBlock(intent).replace(
    /^\n\nWHAT LUKE UNDERSTOOD — [^\n]*/,
    '\n\nWHAT THE OWNER AGREED TO — they read this plan in Luke\'s words and said yes. Build exactly this, in one design, and do not ask again: where it was unsure, take the likelier answer and say it in "message".'
  );
}

/**
 * The plan in words, with no field's name left in it. The planner reads
 * the app's columns by their keys and now and then says one back
 * ("orders_count 2 ya zyada"), which the owner never sees anywhere; with
 * the operator's ideas in the plan it did so in three of five eval cases
 * (4 Oct). Each key that names a column becomes that column's label, and
 * any other snake_case word its plain words.
 */
export function plainSay(say: string, labels: Map<string, string>): string {
  // Not inside an email, an address or a file name: john_doe@… and my_shop.myshopify.com stay.
  return say.replace(
    /(?<![\w@./-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w@./-])/g,
    (key) => labels.get(key) ?? key.replace(/_/g, " ")
  );
}
