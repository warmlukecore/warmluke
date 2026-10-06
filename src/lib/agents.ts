// Luke's agents, named once.
//
// The console's Agents screen takes each card's name and what it does
// from here, and shows a card for every agent here even before the
// database counts it; a reply's breakdown in the chat names each job's
// calls from here. The database adds a card of its own for any model job
// it meets that has no card (0186), so an agent nobody described still
// shows, under its job's name.
//
// A new agent is one entry here. scripts/check-agents.mjs fails until
// every model job (UsageJob) and every step a turn tells is either an
// agent's here or named in TURN_STEPS.
//
// Callers: src/app/[gate]/agents/page.tsx, src/components/ChatPanel.tsx.

import type { UsageJob } from "@/lib/types";

export type AgentInfo = {
  label: string;
  /** What it does, in a line. */
  about: string;
  /** The model jobs its calls are metered under (lib/usage `asJob`); none when it is code. */
  jobs?: UsageJob[];
  /** The step it tells in a turn's trace (lib/engine, lib/review-gate), when it tells one. */
  step?: string;
};

/** Keyed by the name the database's Agents report uses (abo_admin_agents). In the order the screen shows them. */
export const AGENTS: Record<string, AgentInfo> = {
  route: {
    label: "Question router",
    about: "Reads a question about the store and picks which list and period answer it",
    jobs: ["route"],
  },
  talk: {
    label: "Talk",
    about: "Answers on the talk road: the store, the app and the business, without building",
    jobs: ["reply"],
  },
  scout: {
    label: "Scout",
    about:
      "Reads the store field by field before Luke designs: every list's exact fields, how full each is, the values it holds",
    step: "scout",
  },
  plan: {
    label: "Plan",
    about: "Reads the owner's words before a design and says the goal it understood",
    jobs: ["plan"],
    step: "plan",
  },
  design: {
    label: "Design",
    about: "Writes the sections, fields and rules on the design road",
    jobs: ["reply"],
    step: "model",
  },
  validator: {
    label: "Validator",
    about: "Checks a design against what the app can build, and sends it back to be repaired",
    step: "checked",
  },
  critic: {
    label: "Critic",
    about: "Reads the design against what was asked: it fits, or it goes back once",
    jobs: ["critic"],
    step: "critic",
  },
  ops: {
    label: "Operator's view",
    about: "Reads the request as the one who runs the store would, and offers what would help",
    jobs: ["ops"],
    step: "ops",
  },
  simplicity: {
    label: "Simplicity check",
    about: "Reads a design for parts the owner does not need: simple, or it goes back once",
    jobs: ["review"],
    step: "simplicity",
  },
  "data check": {
    label: "Data check",
    about: "Checks the values and fields a design leans on against the store's own rows",
    step: "data",
  },
  "dry-run": {
    label: "Rule dry-run",
    about: "Runs each new rule in the head over the rows it would meet, and counts them",
    step: "dryrun",
  },
  "screen check": {
    label: "Screen check",
    about: "Looks at the screen a design makes, and sends it back once when it would confuse",
    jobs: ["ux"],
    step: "ux",
  },
  tryout: {
    label: "Tryout",
    about: "Tries each part of a design on the store's own rows, and plays the owner's day through it",
    jobs: ["tryout"],
    step: "tryout",
  },
  gap: {
    label: "Gap check",
    about: "Names what the owner asked for that the design leaves out",
    jobs: ["gap"],
    step: "gaps",
  },
  memory: { label: "Memory", about: "Writes down facts about the business after a turn", jobs: ["memory"] },
  reflect: {
    label: "Reflect",
    about: "Turns what went right and wrong into lessons and skills, and patches or retires them",
    jobs: ["reflect"],
  },
  judge: { label: "Judge", about: "A second opinion on each design after the reply: does it do what was asked" },
  "ai step": {
    label: "AI step",
    about: "Reads a row's own words in a rule and fills its other fields: a choice, or a value the words name",
    jobs: ["fill"],
  },
};

/** Steps a turn tells that are the turn's own plumbing, not an agent's. */
export const TURN_STEPS = ["road", "context", "store", "lookup", "prepare", "answer", "proposed", "accepted"];

/** A card's name: the agent's label, or the database's own name for one nobody described yet. */
export const agentLabel = (name: string) => AGENTS[name]?.label ?? name;

/** What a job's calls are called in a reply's breakdown: the agent's label, or the job itself. */
export function jobLabel(job: string): string {
  if (job === "reply") return "Reply";
  return Object.values(AGENTS).find((a) => a.jobs?.includes(job as UsageJob))?.label ?? job;
}
