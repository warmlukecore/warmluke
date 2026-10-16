// ─────────────────────────────────────────────────────────────
// The day's brief, first on the Overview (16 Oct): what needs the owner,
// what changed, what Luke did and what he is watching, ranked by what
// matters and cut to a few lines. No model is called: every line comes
// from what the app already holds (alerts, what waits in the bell, the
// day's builds and their tests, the watches turned on).
//
// Callers: src/components/TodayBrief.tsx, src/lib/app-actions.ts (whats_waiting,
// for Luke and their own AI), scripts/check-brief.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type BriefTone = "critical" | "attention" | "success" | "info";
export type BriefLine = { tone: BriefTone; text: string };

export type BriefInput = {
  /** What waits on the owner's yes, as the bell counts it. */
  waiting: number;
  /** Open alerts, worded (lib/alerts describeAlert). */
  alerts: Array<{ severity: "attention" | "critical"; title: string }>;
  /** The last day's builds, by their thread's title, and whether the test after each passed (null: not tested). */
  builds: Array<{ what: string; ok: boolean | null }>;
  /** Watches turned on with their numbers. */
  watching: number;
};

const DAY = 24 * 60 * 60 * 1000;

/** The day's builds and the watches on, under the caller's own rights (RLS decides). */
export async function readBrief(
  db: SupabaseClient,
  projectId: string
): Promise<Pick<BriefInput, "builds" | "watching">> {
  const [b, s] = await Promise.all([
    db
      .from("messages")
      .select("payload, conversations!inner(project_id, title)")
      .eq("conversations.project_id", projectId)
      .eq("payload->>type", "build")
      .eq("payload->>status", "built")
      .gte("created_at", new Date(Date.now() - DAY).toISOString())
      // limit: a brief counts a day's builds; past fifty it still says "50".
      .limit(50),
    db.rpc("abo_alert_settings", { p_project: projectId }),
  ]);
  const builds = (b.data ?? []).map((m) => {
    const tested = (m.payload as { tested?: { ok?: unknown } } | null)?.tested;
    const thread = m.conversations as unknown as { title?: string | null } | null;
    return { what: thread?.title?.trim() || "A change", ok: typeof tested?.ok === "boolean" ? tested.ok : null };
  });
  const kinds = (s.data as Array<{ enabled?: boolean; set?: boolean }> | null) ?? [];
  return { builds, watching: kinds.filter((k) => k.enabled && k.set !== false).length };
}

/** Never more lines than this: a brief, not every metric there is. */
export const BRIEF_MAX = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The brief, most pressing first: critical alerts, decisions, failed checks, the rest noticed, what was built, what is watched. */
export function briefOf(i: BriefInput): BriefLine[] {
  const out: BriefLine[] = [];
  const critical = i.alerts.filter((a) => a.severity === "critical");
  for (const a of critical.slice(0, 2)) out.push({ tone: "critical", text: a.title });
  if (i.waiting > 0) {
    out.push({
      tone: "attention",
      text: `${plural(i.waiting, "thing")} ${i.waiting === 1 ? "waits" : "wait"} for your yes`,
    });
  }
  for (const b of i.builds.filter((x) => x.ok === false).slice(0, 2)) {
    out.push({ tone: "attention", text: `${b.what}: built, and a check did not pass` });
  }
  const rest = [...critical.slice(2), ...i.alerts.filter((a) => a.severity !== "critical")];
  if (rest.length === 1) out.push({ tone: "attention", text: rest[0].title });
  else if (rest.length > 1) out.push({ tone: "attention", text: `${plural(rest.length, "more thing")} Luke noticed` });
  const good = i.builds.filter((x) => x.ok !== false);
  if (good.length) {
    out.push({
      tone: "success",
      text: `Luke finished ${plural(good.length, "build")} today${good.every((x) => x.ok === true) ? ", each tested on your data" : ""}`,
    });
  }
  if (i.watching > 0) out.push({ tone: "info", text: `Watching ${plural(i.watching, "thing")} for you` });
  return out.slice(0, BRIEF_MAX);
}
