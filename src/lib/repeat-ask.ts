// ─────────────────────────────────────────────────────────────
// "You check this often: shall I keep it?" (16 Oct, the sprint's Days
// 12–13). When the owner asks something like what they asked on other
// days, for the third time or more, Luke answers it and then offers,
// once, to keep it as a saved view or to watch it for them. Nothing is
// built unless they say yes, and a topic offered once is not offered
// again: the answer that offered is marked (reply.offered_repeat), as the
// first meeting marks the answer that asked to open the store.
//
// No model is asked to notice: the owner's own words, compared by the
// words they share (lib/memory wordsOf).
//
// Callers: src/lib/engine.ts, scripts/check-repeat-ask.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { wordsOf } from "@/lib/memory";

/** How far back their asks are read. */
export const REPEAT_DAYS = 30;
/** Asked this many times, the current one with them, on at least two days. */
const TIMES = 3;

export type PastAsk = { text: string; at: string };
export type Repeat = { times: number; days: number; key: string };

const alike = (a: Set<string>, b: Set<string>) => {
  const shared = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return shared >= 2 && union > 0 && shared / union >= 0.5;
};

/**
 * Whether this message is one they keep asking: the earlier asks like it
 * (most of their words shared), how many days they came on, and a key for
 * the topic. Null when it is new, rare, all on one day, or already offered.
 */
export function repeatOf(message: string, past: PastAsk[], offered: string[], now = Date.now()): Repeat | null {
  const asked = wordsOf(message);
  if (asked.size < 2) return null;
  if (offered.some((k) => alike(asked, new Set(k.split(" "))))) return null;
  // The message itself, saved a moment ago, is not an earlier ask.
  const earlier = past.filter((p) => !(p.text.trim() === message.trim() && now - Date.parse(p.at) < 5 * 60_000));
  const like = earlier.filter((p) => alike(asked, wordsOf(p.text)));
  const days = new Set([...like.map((p) => p.at.slice(0, 10)), new Date(now).toISOString().slice(0, 10)]);
  if (like.length + 1 < TIMES || days.size < 2) return null;
  return { times: like.length + 1, days: days.size, key: [...asked].toSorted().slice(0, 6).join(" ") };
}

/** What Luke is told when it is one they keep asking; null otherwise. */
export function describeRepeat(r: Repeat | null): string | null {
  if (!r) return null;
  return `THEY ASK THIS OFTEN: something like this ${r.times} times, on ${r.days} different days lately. Answer it first. Then, once and in one short sentence, offer to keep it as a saved view in their app, or to watch it and tell them when it changes. Build nothing unless they say yes; if they say no or let it pass, do not offer it again.`;
}

/** Their asks over the last month and the topics already offered, read under their own rights. */
export async function repeatFor(db: SupabaseClient, projectId: string, message: string): Promise<Repeat | null> {
  const since = new Date(Date.now() - REPEAT_DAYS * 86_400_000).toISOString();
  const [asks, offers] = await Promise.all([
    db
      .from("messages")
      .select("text:payload->>text, kind:payload->>kind, created_at, conversations!inner(project_id)")
      .eq("conversations.project_id", projectId)
      .eq("role", "user")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      // limit: the newest two hundred asks of the month are enough to see a habit.
      .limit(200),
    db
      .from("messages")
      .select("offered:payload->>offered_repeat, conversations!inner(project_id)")
      .eq("conversations.project_id", projectId)
      .not("payload->>offered_repeat", "is", null)
      // limit: a topic offered once is skipped; fifty offers is more than a month brings.
      .limit(50),
  ]);
  const past = ((asks.data ?? []) as Array<{ text: string | null; kind: string | null; created_at: string }>)
    .filter((m) => m.text && m.kind !== "meet")
    .map((m) => ({ text: m.text as string, at: m.created_at }));
  const offered = ((offers.data ?? []) as Array<{ offered: string | null }>)
    .map((o) => o.offered ?? "")
    .filter(Boolean);
  return repeatOf(message, past, offered);
}
