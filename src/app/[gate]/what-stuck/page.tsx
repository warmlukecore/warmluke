"use client";

// ─────────────────────────────────────────────────────────────
// What stuck (4c, 5 Oct): which builds merchants kept and used, by week
// and by the example Luke was shown, and the library those examples come
// from (0181). A build is kept when, a week on, the sections it made are
// still there and in use: a row put in since, or a rule on them that ran.
//
// Opening this screen is the curator's week: kept builds not yet proposed
// are put in words here (lib/curator.ts: their shape, the owner's words
// with numbers, phones and orders taken out) and wait below. Luke reads
// one only once it is approved, and shows its words to other stores, so
// each is read and edited first.
//
// Everything goes through functions that refuse anyone who is not an
// administrator.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Choices, Stat, adminError } from "@/components/AdminParts";
import { button, card, field, label, note } from "@/components/ui/controls";
import { exampleFromBuild } from "@/lib/curator";
import { SEED_EXAMPLES } from "@/lib/example-seeds";

type Count = { built?: number; shown?: number; judged: number; kept: number };
type Week = Count & { week: string; built: number };
type ByExample = Count & { example: string; shown: number };
type Entry = {
  id: string;
  ask: string;
  design: string;
  why: string;
  tags: string[];
  status: "proposed" | "active";
  proposed_at: string;
  decided_at: string | null;
};
type Report = { weeks: Week[]; examples: ByExample[]; library: Entry[] };

const WEEKS: Array<[number, string]> = [
  [4, "4 weeks"],
  [8, "8 weeks"],
  [26, "6 months"],
];
const rate = (c: Count) => (c.judged === 0 ? "–" : `${Math.round((c.kept / c.judged) * 100)}%`);
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–";

export default function WhatStuckPage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);
  const [weeks, setWeeks] = useState(8);
  const [proposed, setProposed] = useState(0);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_what_stuck", { p_weeks: weeks });
    if (err) {
      setError(adminError(err, "0181"));
      return;
    }
    setError(null);
    setR(data as Report);
  }, [weeks]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // The curator's week: kept builds not yet proposed, put in words and proposed, once a visit.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data, error: err } = await supabase.rpc("abo_admin_kept_builds", { p_limit: 20 });
      if (err || !Array.isArray(data)) return;
      let n = 0;
      for (const k of data as Array<{ build_id: string; asked: string | null; design: unknown }>) {
        const ex = exampleFromBuild(k.asked, k.design);
        if (!ex) continue;
        const { error: e } = await supabase.rpc("abo_admin_propose_example", {
          p_build: k.build_id,
          p_ask: ex.ask,
          p_design: ex.design,
          p_tags: ex.tags,
        });
        if (!e) n++;
      }
      if (n) {
        setProposed(n);
        await load();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const decide = async (id: string, status: "active" | "retired", edits: Partial<Entry>) => {
    const { error: err } = await supabase.rpc("abo_admin_decide_example", {
      p_id: id,
      p_status: status,
      p_ask: edits.ask ?? null,
      p_design: edits.design ?? null,
      p_why: edits.why ?? null,
      p_tags: edits.tags ?? null,
    });
    if (err) setError(err.message);
    else await load();
  };

  if (loading || !user || (!r && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-24 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  const all = (r?.weeks ?? []).reduce(
    (a, w) => ({ built: a.built + w.built, judged: a.judged + w.judged, kept: a.kept + w.kept }),
    { built: 0, judged: 0, kept: 0 }
  );
  const library = r?.library ?? [];
  const waiting = library.filter((e) => e.status === "proposed");
  const active = library.filter((e) => e.status === "active");
  const named = (id: string) =>
    SEED_EXAMPLES.find((s) => s.id === id)?.ask ?? library.find((e) => e.id === id)?.ask ?? "an example since retired";

  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">What stuck</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              Builds still there and in use a week on, by week and by the example Luke was shown; and the examples Luke
              designs from.
            </p>
          </div>
          <Choices options={WEEKS} value={weeks} onChange={setWeeks} />
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {r && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <Stat label="Sections built" value={all.built} sub="by builds that said what they made" />
              <Stat label="A week on" value={all.judged} sub="old enough to tell" />
              <Stat label="Kept and used" value={all.kept} sub={`${rate(all)} of those a week on`} />
            </div>

            <div className={`${card} mt-4 overflow-x-auto p-4`}>
              <div className="text-xs font-medium text-fg-muted">By week built (from Monday, UTC)</div>
              {r.weeks.length === 0 ? (
                <div className="mt-2 text-[13px] text-fg-faint">No builds in this time.</div>
              ) : (
                <table className="mt-2 w-full text-[13px] tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-fg-muted">
                      <th className="py-1 font-medium">Week of</th>
                      <th className="py-1 text-right font-medium">Built</th>
                      <th className="py-1 text-right font-medium">A week on</th>
                      <th className="py-1 text-right font-medium">Kept</th>
                      <th className="py-1 text-right font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.weeks.map((w) => (
                      <tr key={w.week} className="border-t border-line">
                        <td className="py-1.5 text-fg">{date(w.week)}</td>
                        <td className="py-1.5 text-right">{w.built}</td>
                        <td className="py-1.5 text-right">{w.judged}</td>
                        <td className="py-1.5 text-right">{w.kept}</td>
                        <td className="py-1.5 text-right font-medium text-fg">{rate(w)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className={`${card} mt-4 p-4`}>
              <div className="text-xs font-medium text-fg-muted">By the example Luke was shown</div>
              {r.examples.length === 0 ? (
                <div className="mt-2 text-[13px] text-fg-faint">
                  No build in this time was designed beside an example.
                </div>
              ) : (
                <ul className="mt-2 space-y-2">
                  {r.examples.map((e) => (
                    <li key={e.example} className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="min-w-0 truncate text-fg">&ldquo;{named(e.example)}&rdquo;</span>
                      <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                        shown {e.shown} · kept {e.kept} of {e.judged} · {rate(e)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <h2 className="mt-8 text-sm font-semibold text-fg">Waiting for your word ({waiting.length})</h2>
            <p className="mt-1 text-[13px] text-fg-muted">
              Kept builds, put in words. Read each for anything of theirs (a name, a brand, a number) before approving:
              Luke shows these words to other stores.
              {proposed > 0 && ` ${proposed} proposed just now.`}
            </p>
            {waiting.length === 0 ? (
              <div className="mt-3 text-[13px] text-fg-faint">Nothing waiting.</div>
            ) : (
              <div className="mt-3 space-y-3">
                {waiting.map((e) => (
                  <Proposed key={e.id} entry={e} onDecide={decide} />
                ))}
              </div>
            )}

            <h2 className="mt-8 text-sm font-semibold text-fg">
              Examples Luke reads ({active.length + SEED_EXAMPLES.length})
            </h2>
            <ul className="mt-3 space-y-2">
              {active.map((e) => (
                <li key={e.id} className={`${card} flex items-start justify-between gap-3 p-3 text-[13px]`}>
                  <div className="min-w-0">
                    <div className="text-fg">&ldquo;{e.ask}&rdquo;</div>
                    <div className="mt-0.5 text-xs text-fg-muted">Approved {date(e.decided_at)}, from a kept build</div>
                  </div>
                  <button className={button("critical-plain", "sm")} onClick={() => decide(e.id, "retired", {})}>
                    Retire
                  </button>
                </li>
              ))}
              {SEED_EXAMPLES.map((s) => (
                <li key={s.id} className={`${card} p-3 text-[13px]`}>
                  <div className="text-fg">&ldquo;{s.ask}&rdquo;</div>
                  <div className="mt-0.5 text-xs text-fg-muted">One of ours, kept in the code</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </PageFrame>
  );
}

/** A kept build put in words, to edit and approve or retire. */
function Proposed({
  entry,
  onDecide,
}: {
  entry: Entry;
  onDecide: (id: string, status: "active" | "retired", edits: Partial<Entry>) => Promise<void>;
}) {
  const [ask, setAsk] = useState(entry.ask);
  const [design, setDesign] = useState(entry.design);
  const [why, setWhy] = useState(entry.why);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const go = async (status: "active" | "retired") => {
    setBusy(true);
    await onDecide(entry.id, status, {
      ask,
      design,
      why,
      tags: tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    });
    setBusy(false);
  };
  const id = `ex-${entry.id}`;
  return (
    <div className={`${card} space-y-3 p-4`}>
      <div>
        <label htmlFor={`${id}-ask`} className={label}>
          What they asked
        </label>
        <textarea id={`${id}-ask`} rows={2} className={field} value={ask} onChange={(e) => setAsk(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-design`} className={label}>
          What was built
        </label>
        <textarea
          id={`${id}-design`}
          rows={4}
          className={field}
          value={design}
          onChange={(e) => setDesign(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-why`} className={label}>
            Why this shape
          </label>
          <input id={`${id}-why`} className={field} value={why} onChange={(e) => setWhy(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-tags`} className={label}>
            Words it is found by
          </label>
          <input id={`${id}-tags`} className={field} value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-faint">Proposed {date(entry.proposed_at)}</span>
        <div className="flex gap-2">
          <button className={button("plain", "sm")} disabled={busy} onClick={() => go("retired")}>
            Not this one
          </button>
          <button
            className={button("primary", "sm")}
            disabled={busy || ask.trim().length < 10}
            onClick={() => go("active")}
          >
            Approve for Luke
          </button>
        </div>
      </div>
    </div>
  );
}
