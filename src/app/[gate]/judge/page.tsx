"use client";

// ─────────────────────────────────────────────────────────────
// Judge (0190): recent designs the shadow judge read (0082), each to be
// marked right or wrong by an administrator, with what the owner said
// when they were asked about the build (their follow-up counts as a mark
// too). Above them, how often the judge agrees with people: the number
// that decides whether it may ever send a design back before the owner
// sees it. Through functions that refuse anyone not an administrator.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { scopeArgs, useConsoleScope } from "@/lib/console-scope";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { PageFrame } from "@/components/PageFrame";
import { ListPanel, adminError, matches } from "@/components/AdminParts";
import { card, note } from "@/components/ui/controls";

type Item = {
  id: string;
  at: string;
  source: string;
  request: string;
  built: string;
  unmet: unknown[];
  addresses: number | null;
  marked: boolean | null;
  owner_said: "fine" | "missed" | null;
  project: string | null;
};
type Queue = {
  items: Item[];
  agreement: {
    judged: number;
    marked: number;
    agree: number;
    judge_yes_people_no: number;
    judge_no_people_yes: number;
  };
};

/** Marks a gate needs before it is trusted, and how often it must agree. */
const ENOUGH = 30;
const TRUSTED = 0.8;

export default function JudgePage() {
  const { user, loading } = useUser();
  const scope = useConsoleScope();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState<Queue | null>(null);
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_judge_queue", { p_limit: 100, ...scopeArgs(scope) });
    if (err) {
      setError(adminError(err, "0190"));
      return;
    }
    setError(null);
    setQ(data as Queue);
    setNow(Date.now());
  }, [scope]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  /** Right, wrong, or the same mark again to take it back. */
  const mark = async (it: Item, right: boolean) => {
    setBusy(it.id);
    const next = it.marked === right ? null : right;
    const { error: err } = await supabase.rpc("abo_admin_judge_label", { p_judgement: it.id, p_right: next });
    setBusy(null);
    if (err) setError(adminError(err, "0190"));
    else await load();
  };

  if (loading || !user || (!q && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-24 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-28 animate-pulse rounded-card bg-surface shadow-card" />
          <div className="mt-4 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  const a = q?.agreement;
  const share = a && a.marked > 0 ? a.agree / a.marked : null;
  const shown = (q?.items ?? []).filter((it) => matches(find, it.request, it.built, it.project));
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Judge</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          Mark recent designs right or wrong. How often the judge agrees with people decides whether it may send a
          design back before the owner sees it.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {a && (
          <div className={`${card} mt-6 p-5`}>
            <div className="text-[13px] font-medium text-fg">
              {a.marked === 0
                ? "Nothing marked yet"
                : `Agrees with people on ${a.agree} of ${a.marked} (${Math.round((share ?? 0) * 100)}%)`}
            </div>
            <p className="mt-1 text-xs text-fg-muted tabular-nums">
              {a.judged} {a.judged === 1 ? "design" : "designs"} judged · it said yes where people said no{" "}
              {a.judge_yes_people_no}, no where they said yes {a.judge_no_people_yes}. An owner&rsquo;s answer to
              &ldquo;Did it work?&rdquo; counts as a mark.
            </p>
            <p className="mt-2 text-xs text-fg-faint">
              {a.marked < ENOUGH
                ? `${ENOUGH - a.marked} more marks before the number means much.`
                : share !== null && share >= TRUSTED
                  ? "Enough marks, and it agrees often enough to be trusted to send a design back once."
                  : "Enough marks, and it disagrees too often: keep it a gauge, or switch it off."}
            </p>
          </div>
        )}

        {q && q.items.length > 0 && (
          <div className="mt-4">
            <ListPanel
              query={find}
              onQuery={setFind}
              placeholder="Find by what was asked, built or the app"
              shown={shown.length}
              total={q.items.length}
              noun="designs"
            >
              <ul className="divide-y divide-line">
                {shown.length === 0 && (
                  <li className="px-5 py-8 text-center text-[13px] text-fg-muted">Nothing matches.</li>
                )}
                {shown.map((it) => (
                  <li key={it.id} className="px-5 py-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-fg-faint">
                      <span>
                        {it.project ?? "An app since deleted"} · {it.source === "mcp" ? "their AI" : "Luke"} ·{" "}
                        {ago(it.at, now)}
                      </span>
                      <span className="tabular-nums">
                        judge {it.addresses === null ? "—" : `${Math.round(it.addresses * 100)}% does what was asked`}
                        {it.owner_said && ` · owner: ${it.owner_said === "fine" ? "it's fine" : "not what I meant"}`}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-fg">
                      <span className="text-fg-muted">Asked: </span>
                      {it.request}
                    </p>
                    <p className="mt-1 line-clamp-3 text-xs text-fg-muted" title={it.built}>
                      <span className="text-fg-faint">Built: </span>
                      {it.built}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      {(
                        [
                          [true, "Right", Check],
                          [false, "Wrong", X],
                        ] as const
                      ).map(([right, word, Mark]) => (
                        <button
                          key={word}
                          type="button"
                          aria-pressed={it.marked === right}
                          disabled={busy === it.id}
                          onClick={() => void mark(it, right)}
                          className={`inline-flex items-center gap-1 rounded-control border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                            it.marked === right
                              ? right
                                ? "border-tone-success-fg bg-tone-success text-tone-success-fg"
                                : "border-tone-critical-fg bg-tone-critical text-tone-critical-fg"
                              : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
                          }`}
                        >
                          <Mark aria-hidden size={12} strokeWidth={2} />
                          {word}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </ListPanel>
          </div>
        )}
        {q && q.items.length === 0 && (
          <div className={`${card} mt-4 px-5 py-10 text-center text-[13px] text-fg-muted`}>
            No designs judged in this scope yet.
          </div>
        )}
      </div>
    </PageFrame>
  );
}
