"use client";

// ─────────────────────────────────────────────────────────────
// Tour — the first look round the app, from the administrator's side
// (0157).
//
// Whether new people are shown it, what each stop says, and who saw it:
// who went to the end, who closed it and at which stop, and who took it
// again. A person can be shown it once more. The stops themselves are in
// the code (lib/tour.ts), beside the screen they point at; only their
// words are changed here.
//
// Everything goes through functions that refuse anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { TOUR_STOPS, type TourCopy } from "@/lib/tour";
import { PageFrame } from "@/components/PageFrame";
import { button, card, field, label, note } from "@/components/ui/controls";
import { Switch } from "@/components/ui/Switch";

type Person = {
  user_id: string;
  email: string | null;
  first_at: string;
  last_at: string;
  times: number;
  outcome: "finished" | "closed" | null;
  reached: number;
  stops: number;
  closed_on: string | null;
};
type Report = {
  totals: { shown: number; finished: number; closed: number; open: number; again: number };
  closed_on: Record<string, number>;
  people: Person[];
};

const NEEDS: Record<string, string> = {
  store: "Shown when the project has a store",
  build: "Shown to people who can build",
};
const titleOf = (key: string | null) => TOUR_STOPS.find((s) => s.key === key)?.title ?? key ?? "a stop";

export default function TourAdmin() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [saved, setSaved] = useState<{ enabled: boolean; copy: TourCopy } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [copy, setCopy] = useState<TourCopy>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace("/login?next=/admin/tour");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      supabase.rpc("abo_admin_tour_report", { p_limit: 200 }),
      supabase.from("tour_settings").select("enabled, copy").maybeSingle(),
    ]);
    setNow(Date.now());
    if (r.error) {
      setError(
        r.error.code === "42501"
          ? "This page is for administrators."
          : r.error.code === "PGRST202"
            ? "This database does not have the tour yet: apply migration 0157."
            : r.error.message
      );
      return;
    }
    setError(null);
    setReport(r.data as Report);
    if (s.data) {
      const settings = { enabled: s.data.enabled as boolean, copy: (s.data.copy ?? {}) as TourCopy };
      setSaved(settings);
      setEnabled(settings.enabled);
      setCopy(settings.copy);
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const wordsOf = (key: string, part: "title" | "body") => copy[key]?.[part] ?? "";
  const setWords = (key: string, part: "title" | "body", value: string) =>
    setCopy((c) => ({ ...c, [key]: { ...c[key], [part]: value } }));
  const dirty =
    !!saved && (enabled !== saved.enabled || JSON.stringify(clean(copy)) !== JSON.stringify(clean(saved.copy)));

  async function save() {
    setBusy(true);
    setSaid(null);
    const { data, error: err } = await supabase.rpc("abo_admin_set_tour", { p_enabled: enabled, p_copy: clean(copy) });
    setBusy(false);
    if (err) {
      setSaid({ ok: false, text: err.message });
      return;
    }
    const row = data as { enabled: boolean; copy: TourCopy };
    setSaved({ enabled: row.enabled, copy: row.copy });
    setCopy(row.copy);
    setSaid({ ok: true, text: "Saved. The new words show from the next tour that opens." });
  }

  async function reset(p: Person) {
    setResetting(p.user_id);
    const { error: err } = await supabase.rpc("abo_admin_tour_reset", { p_user: p.user_id });
    setResetting(null);
    if (err) {
      setSaid({ ok: false, text: err.message });
      return;
    }
    await load();
  }

  if (loading || !user || (!report && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  const t = report?.totals;
  const share = (n: number) => (t && t.shown > 0 ? `${Math.round((n / t.shown) * 100)}%` : "–");
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Tour</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          The first look round the app: shown once to each person, opened again from the compass at the foot of the
          sidebar.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {report && t && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ["Shown", t.shown.toLocaleString(), "people"],
                  ["To the end", t.finished.toLocaleString(), share(t.finished)],
                  ["Closed early", t.closed.toLocaleString(), share(t.closed)],
                  ["Left open", t.open.toLocaleString(), "tab went away"],
                  ["Took it again", t.again.toLocaleString(), share(t.again)],
                ] as const
              ).map(([name, value, sub]) => (
                <div key={name} className={`${card} p-4`}>
                  <div className="text-xs text-fg-muted">{name}</div>
                  <div className="mt-1 text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
                  <div className="mt-0.5 text-xs text-fg-faint">{sub}</div>
                </div>
              ))}
            </div>

            {t.closed > 0 && (
              <div className={`${card} mt-4 p-5`}>
                <div className="text-[13px] font-medium text-fg">Where it was closed</div>
                <ul className="mt-3 space-y-2">
                  {TOUR_STOPS.filter((s) => report.closed_on[s.key]).map((s) => {
                    const n = report.closed_on[s.key] ?? 0;
                    return (
                      <li key={s.key} className="flex items-center gap-3 text-[13px]">
                        <span className="w-40 shrink-0 truncate text-fg">{s.title}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-subdued">
                          <span
                            className="block h-full rounded-full bg-signal-attention"
                            style={{ width: `${Math.max(4, (n / t.closed) * 100)}%` }}
                          />
                        </span>
                        <span className="w-10 text-right text-xs text-fg-muted tabular-nums">{n}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className={`${card} mt-4 p-5`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[13px] font-medium text-fg">Show it to new people</div>
                  <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-fg-muted">
                    {enabled
                      ? "On: anyone who has not seen it gets it the first time they open the app. Blank words are the app’s own."
                      : "Off: nobody is shown it by itself. The compass at the foot of the sidebar still opens it."}
                  </p>
                </div>
                <Switch checked={enabled} onChange={setEnabled} label="Show the tour to new people" />
              </div>
              <ol className="mt-5 space-y-4">
                {TOUR_STOPS.map((s, i) => (
                  <li key={s.key} className="rounded-control border border-line p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-xs font-medium text-fg-muted">Stop {i + 1}</div>
                      {s.needs && <div className="text-[11px] text-fg-faint">{NEEDS[s.needs]}</div>}
                    </div>
                    <div className="mt-2 grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
                      <div>
                        <label htmlFor={`tour-${s.key}-title`} className={label}>
                          Title
                        </label>
                        <input
                          id={`tour-${s.key}-title`}
                          className={field}
                          maxLength={80}
                          value={wordsOf(s.key, "title")}
                          placeholder={s.title}
                          onChange={(e) => setWords(s.key, "title", e.target.value)}
                        />
                      </div>
                      <div>
                        <label htmlFor={`tour-${s.key}-body`} className={label}>
                          What it says
                        </label>
                        <textarea
                          id={`tour-${s.key}-body`}
                          className={`${field} h-auto min-h-[4.5rem] py-2 leading-relaxed`}
                          maxLength={400}
                          rows={2}
                          value={wordsOf(s.key, "body")}
                          placeholder={s.body}
                          onChange={(e) => setWords(s.key, "body", e.target.value)}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              {said && (
                <div role="status" className={`${said.ok ? note.success : note.critical} mt-4 text-[13px]`}>
                  {said.text}
                </div>
              )}
              <div className="mt-4 flex justify-end">
                <button onClick={save} disabled={!dirty || busy} className={button("primary", "sm")}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            <div className={`${card} mt-4 overflow-hidden`}>
              <div className="border-b border-line px-5 py-3.5">
                <div className="text-[13px] font-medium text-fg">Who saw it</div>
                <p className="mt-0.5 text-xs text-fg-muted">
                  The latest {report.people.length.toLocaleString()} of {t.shown.toLocaleString()}, newest first.
                </p>
              </div>
              {report.people.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-fg-muted">Nobody has been shown it yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {report.people.map((p) => (
                    <li key={p.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                      <span className="min-w-0 flex-1 truncate text-fg">{p.email ?? "An account since deleted"}</span>
                      <span className="text-xs text-fg-muted">
                        {p.outcome === "finished"
                          ? `To the end, ${p.stops} stops`
                          : p.outcome === "closed"
                            ? `Closed at “${titleOf(p.closed_on)}”, ${p.reached} of ${p.stops}`
                            : "Left open"}
                      </span>
                      <span className="w-28 text-xs text-fg-faint" title={new Date(p.last_at).toLocaleString()}>
                        {p.times > 1 ? `${p.times} times, ` : ""}
                        {ago(p.last_at, now)}
                      </span>
                      <button
                        onClick={() => reset(p)}
                        disabled={resetting === p.user_id}
                        title="Show it to them again the next time they open the app"
                        className={button("plain", "sm")}
                      >
                        {resetting === p.user_id ? "Resetting…" : "Show again"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}

/** What is saved: only stops with words of their own, trimmed. */
function clean(copy: TourCopy): TourCopy {
  const out: TourCopy = {};
  for (const [key, v] of Object.entries(copy)) {
    const title = v?.title?.trim();
    const body = v?.body?.trim();
    if (title || body) out[key] = { ...(title ? { title } : {}), ...(body ? { body } : {}) };
  }
  return out;
}
