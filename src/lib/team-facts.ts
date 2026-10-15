// ─────────────────────────────────────────────────────────────
// Who does what, and how long a restock takes (0222).
//
// Asked once, after the store is connected (onboarding "Your team"), and
// kept in Settings. Each answer is a line of what Luke knows
// (merchant_notes, 0220) that the work stands on: read on every turn,
// never pushed out by newer chat, and replaced, not doubled, when it is
// answered again (one line a topic). The restock time is also a number
// on the project, which Running low reads (abo_alert_low_stock).
//
// Callers: src/components/TeamFacts.tsx, scripts/check-team-facts.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

type Kind = "team" | "lead_time" | "fact";
type TextKey = "packing" | "customers" | "ads" | "restocking" | "tools";
type Question = { key: TextKey; label: string; hint: string; topic: string; kind: Kind; said: (a: string) => string };

/** The questions, in the order asked: who does each part, then the tools. */
export const TEAM_QUESTIONS: readonly Question[] = [
  {
    key: "packing",
    label: "Who packs and ships orders?",
    hint: "A name, “me”, or “a 3PL”",
    topic: "team: packing",
    kind: "team",
    said: (a) => `Packing and shipping: ${a}`,
  },
  {
    key: "customers",
    label: "Who answers customers and handles returns?",
    hint: "A name, or “me”",
    topic: "team: customers",
    kind: "team",
    said: (a) => `Customer messages and returns: ${a}`,
  },
  {
    key: "ads",
    label: "Who runs your ads?",
    hint: "A name, an agency, or “me”",
    topic: "team: ads",
    kind: "team",
    said: (a) => `Ads: ${a}`,
  },
  {
    key: "restocking",
    label: "Who restocks and talks to suppliers?",
    hint: "A name, or “me”",
    topic: "team: restocking",
    kind: "team",
    said: (a) => `Restocking and suppliers: ${a}`,
  },
  {
    key: "tools",
    label: "What else do you run the store with?",
    hint: "Courier, payments, WhatsApp, a spreadsheet…",
    topic: "tools",
    kind: "fact",
    said: (a) => `Tools they use: ${a}`,
  },
];

/** The restock time, as a line of what Luke knows. */
export const LEAD_TOPIC = "lead time: restock";
const leadLine = (days: number) => `A restock usually takes ${days} ${days === 1 ? "day" : "days"} to arrive`;

/** Every topic this form writes: answering again retires them all first. */
export const TEAM_TOPICS = [...TEAM_QUESTIONS.map((q) => q.topic), LEAD_TOPIC];

export type TeamAnswers = Record<TextKey, string> & { restock_days: string };
export const NO_ANSWERS: TeamAnswers = {
  packing: "",
  customers: "",
  ads: "",
  restocking: "",
  tools: "",
  restock_days: "",
};

const ANSWER_MAX = 120;
const OWNER = "the owner themselves";

/** "Me" is the owner, said so Luke never reads it as someone called Me. */
const who = (a: string) => (/^(me|myself|i do|i|main|khud|mai|mein)$/i.test(a) ? OWNER : a);

/** A restock time as given: a whole number of days, 1 to 365, or null. */
const daysOf = (raw: string): number | null => {
  const t = raw.trim();
  return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 365 ? Number(t) : null;
};

/** What is wrong with the answers, field by field; empty when they can be saved. Every answer is optional. */
export function teamProblems(a: TeamAnswers): Partial<Record<keyof TeamAnswers, string>> {
  const out: Partial<Record<keyof TeamAnswers, string>> = {};
  for (const q of TEAM_QUESTIONS) {
    if (a[q.key].trim().length > ANSWER_MAX) out[q.key] = `Up to ${ANSWER_MAX} characters.`;
  }
  if (a.restock_days.trim() && daysOf(a.restock_days) === null) out.restock_days = "A number of days, 1 to 365.";
  return out;
}

/** The answers as lines of what Luke knows: one a topic, the owner's, the ones left blank left out. */
export function teamNotes(a: TeamAnswers): Array<{ note: string; kind: Kind; topic: string; source: "owner" }> {
  const out: Array<{ note: string; kind: Kind; topic: string; source: "owner" }> = [];
  for (const q of TEAM_QUESTIONS) {
    const said = a[q.key].replace(/\s+/g, " ").trim().slice(0, ANSWER_MAX);
    if (said)
      out.push({ note: q.said(q.kind === "team" ? who(said) : said), kind: q.kind, topic: q.topic, source: "owner" });
  }
  const days = daysOf(a.restock_days);
  if (days !== null) out.push({ note: leadLine(days), kind: "lead_time", topic: LEAD_TOPIC, source: "owner" });
  return out;
}

/** What was answered before, from the lines it wrote and the project's restock time, to show in the form. */
export function answersFrom(
  notes: Array<{ note: string; topic: string | null }>,
  restockDays: number | null
): TeamAnswers {
  const out: TeamAnswers = { ...NO_ANSWERS, restock_days: restockDays ? String(restockDays) : "" };
  for (const q of TEAM_QUESTIONS) {
    const line = notes.find((n) => n.topic === q.topic)?.note ?? "";
    const head = q.said("");
    const said = line.startsWith(head) ? line.slice(head.length) : "";
    out[q.key] = said === OWNER ? "Me" : said;
  }
  return out;
}

/** Reads what was answered, under the caller's own rights. */
export async function loadTeam(db: SupabaseClient, projectId: string): Promise<TeamAnswers> {
  const [{ data: notes }, { data: project }] = await Promise.all([
    db.from("merchant_notes").select("note, topic").eq("project_id", projectId).in("topic", TEAM_TOPICS),
    db.from("projects").select("restock_days").eq("id", projectId).maybeSingle(),
  ]);
  return answersFrom(
    (notes ?? []) as Array<{ note: string; topic: string | null }>,
    (project as { restock_days?: number | null } | null)?.restock_days ?? null
  );
}

/**
 * Keeps the answers: the lines this form wrote before are retired, the
 * new ones kept, and the restock time and that it was asked set on the
 * project. Returns the first error, or null.
 */
export async function saveTeam(db: SupabaseClient, projectId: string, a: TeamAnswers): Promise<string | null> {
  const gone = await db.from("merchant_notes").delete().eq("project_id", projectId).in("topic", TEAM_TOPICS);
  if (gone.error) return gone.error.message;
  const rows = teamNotes(a).map((n) => ({ project_id: projectId, ...n }));
  if (rows.length) {
    const kept = await db.from("merchant_notes").insert(rows);
    if (kept.error) return kept.error.message;
  }
  const project = await db
    .from("projects")
    .update({ restock_days: daysOf(a.restock_days), team_asked_at: new Date().toISOString() })
    .eq("id", projectId);
  return project.error?.message ?? null;
}

/** Skipped: not asked again; Settings keeps it. */
export async function skipTeam(db: SupabaseClient, projectId: string): Promise<string | null> {
  const { error } = await db.from("projects").update({ team_asked_at: new Date().toISOString() }).eq("id", projectId);
  return error?.message ?? null;
}
