"use client";

// ─────────────────────────────────────────────────────────────
// Spend — what Luke cost, from every turn's priced usage (0159).
//
// Each day (UTC), each model (a turn's calls split by the model that made
// them: the reply, the gap pass, the critic), and the accounts that spent
// most. Read from the traces, so it reaches back only as far as Data &
// privacy keeps them. A call whose price is not known counts nothing, and
// the turns with one are said.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { scopeArgs, useConsoleScope } from "@/lib/console-scope";
import { useUser } from "@/lib/auth";
import { dollars, modelName, tokensShort } from "@/lib/model-prices";
import { PageFrame } from "@/components/PageFrame";
import { Choices, adminError } from "@/components/AdminParts";
import { card, note } from "@/components/ui/controls";

type Spend = {
  since: string;
  total: { usd: number; turns: number; accounts: number; partial: number };
  days: Array<{ day: string; usd: number; turns: number }>;
  models: Array<{ model: string; usd: number; calls: number; input: number; output: number }>;
  accounts: Array<{ user_id: string; email: string | null; usd: number; turns: number }>;
  kept_from: string | null;
};

const DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
/** Nothing is "$0", not the four places a small reply needs. */
const money = (n: number) => (n === 0 ? "$0" : dollars(n));
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

export default function SpendPage() {
  const { user, loading } = useUser();
  // Whose numbers: every account, one, or one app of it (0184).
  const scope = useConsoleScope();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [s, setS] = useState<Spend | null>(null);
  // Data & privacy's clean-up: kept days shorter than the window empty its first days.
  const [kept, setKept] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  // How often the rules sent a turn down the wrong road (0169).
  const [routing, setRouting] = useState<{
    turns: number;
    answered_on_design: number;
    handed_back: number;
    wrong_road_usd: number;
  } | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const [{ data, error: err }, r, road] = await Promise.all([
      supabase.rpc("abo_admin_spend", { p_days: days, ...scopeArgs(scope) }),
      supabase.rpc("abo_admin_retention"),
      supabase.rpc("abo_admin_routing", { p_days: days, ...scopeArgs(scope) }),
    ]);
    // Not there yet (0169 not run) is no reason to hide what is.
    setRouting((road.data as typeof routing) ?? null);
    if (err) {
      setError(adminError(err, "0159"));
      return;
    }
    setError(null);
    setS(data as Spend);
    const rule = r.data as { enabled: boolean; days: number } | null;
    setKept(rule?.enabled ? rule.days : null);
  }, [days, scope]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user || (!s && !error)) {
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
  const usd = Number(s?.total.usd ?? 0);
  const peak = Math.max(0, ...(s?.days.map((d) => Number(d.usd)) ?? []));
  const top = Math.max(0, Number(s?.models[0]?.usd ?? 0));
  // The early days read nothing because nothing was kept, not because nothing was spent.
  const short = kept !== null && kept < days;
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Spend</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              What Luke&rsquo;s model calls cost, by day (UTC), model and account.
            </p>
          </div>
          <Choices options={DAYS} value={days} onChange={setDays} />
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {s && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["Spent", money(usd), `in ${days} days`],
                  ["Turns", s.total.turns.toLocaleString(), "priced replies"],
                  ["A turn, on average", s.total.turns ? money(usd / s.total.turns) : "–", "all its calls"],
                  ["Accounts", s.total.accounts.toLocaleString(), "that spent anything"],
                ] as const
              ).map(([name, value, sub]) => (
                <div key={name} className={`${card} p-4`}>
                  <div className="text-xs text-fg-muted">{name}</div>
                  <div className="mt-1 text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
                  <div className="mt-0.5 text-xs text-fg-faint">{sub}</div>
                </div>
              ))}
            </div>

            {routing && routing.turns > 0 && (
              // A wrong road is never a wrong answer, only a dearer one: past
              // one turn in ten, the rules need a small model's help.
              <div className={`${card} mt-3 p-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-xs text-fg-muted">Road choice</div>
                  <div className="text-xs text-fg-faint">how often a turn took the dearer road for nothing</div>
                </div>
                {(() => {
                  const wrong = routing.answered_on_design + routing.handed_back;
                  const share = wrong / routing.turns;
                  return (
                    <>
                      <div className="mt-1 text-xl font-semibold tracking-tight text-fg tabular-nums">
                        {wrong.toLocaleString()} of {routing.turns.toLocaleString()} turns · {Math.round(share * 100)}%
                      </div>
                      <div className="mt-0.5 text-xs text-fg-faint">
                        {routing.answered_on_design} answered on the design road (
                        {money(Number(routing.wrong_road_usd))}), {routing.handed_back} handed back from the talk road
                      </div>
                      {share >= 0.1 && (
                        <p className={`${note.attention} mt-3`}>
                          More than one turn in ten took the wrong road: time for a small model to read the messages the
                          rules are unsure of.
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {(short || s.total.partial > 0) && (
              <div className={`${note.attention} mt-4 space-y-1`}>
                {short && (
                  <p>Traces are kept for {kept} days (Data &amp; privacy), so the days before that show nothing.</p>
                )}
                {s.total.partial > 0 && (
                  <p>
                    {s.total.partial.toLocaleString()} {s.total.partial === 1 ? "turn had" : "turns had"} a call with no
                    known price, so the dollars are a little short.
                  </p>
                )}
              </div>
            )}

            <div className={`${card} mt-4 p-5`}>
              <div className="text-[13px] font-medium text-fg">Each day</div>
              <div
                className="mt-4 flex h-40 items-end gap-px"
                role="img"
                aria-label={`Spend each day for ${days} days`}
              >
                {s.days.map((d) => (
                  <div
                    key={d.day}
                    className="group flex h-full min-w-0 flex-1 items-end"
                    title={`${day(d.day)}: ${money(Number(d.usd))}, ${d.turns} ${d.turns === 1 ? "turn" : "turns"}`}
                  >
                    <div
                      className="w-full rounded-t-sm bg-primary/70 transition-colors group-hover:bg-primary"
                      style={{
                        height: peak > 0 ? `${Math.max(Number(d.usd) > 0 ? 2 : 0, (Number(d.usd) / peak) * 100)}%` : 0,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-fg-faint tabular-nums">
                <span>{s.days[0] && day(s.days[0].day)}</span>
                <span>highest {money(peak)}</span>
                <span>{s.days.length > 0 && day(s.days[s.days.length - 1].day)}</span>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className={`${card} p-5`}>
                <div className="text-[13px] font-medium text-fg">By model</div>
                {s.models.length === 0 ? (
                  <p className="mt-3 text-[13px] text-fg-muted">No priced calls in this window.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {s.models.map((m) => (
                      <li key={m.model} className="text-[13px]">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-fg" title={m.model}>
                            {modelName(m.model)}
                          </span>
                          <span className="text-fg tabular-nums">{money(Number(m.usd))}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-subdued">
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${top > 0 ? Math.max(2, (Number(m.usd) / top) * 100) : 0}%` }}
                          />
                        </div>
                        <div className="mt-1 text-xs text-fg-faint tabular-nums">
                          {m.calls.toLocaleString()} {m.calls === 1 ? "call" : "calls"} · {tokensShort(m.input)} in ·{" "}
                          {tokensShort(m.output)} out
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className={`${card} overflow-hidden`}>
                <div className="px-5 pt-5 text-[13px] font-medium text-fg">Accounts that spent most</div>
                {s.accounts.length === 0 ? (
                  <p className="px-5 py-3 text-[13px] text-fg-muted">Nobody in this window.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-line">
                    {s.accounts.map((a) => (
                      <li key={a.user_id} className="flex items-baseline gap-3 px-5 py-2.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate text-fg" title={a.email ?? undefined}>
                          {a.email ?? "An account since deleted"}
                        </span>
                        <span className="text-xs text-fg-faint tabular-nums">
                          {a.turns.toLocaleString()} {a.turns === 1 ? "turn" : "turns"}
                        </span>
                        <span className="w-20 text-right text-fg tabular-nums">{money(Number(a.usd))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}
