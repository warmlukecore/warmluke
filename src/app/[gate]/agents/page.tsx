"use client";

// ─────────────────────────────────────────────────────────────
// Agents: how each of Luke's agents did (0176), read from what the turns
// left (0132) and the learning timeline. The planner, the design call,
// the validator, the critic, the gap pass, memory, the reflector and the
// shadow judge: how often each ran, how its runs came out, and what its
// calls cost; and how long a turn takes on each road.
//
// Dollars are the meter's, priced when the turn ended, as Spend reads
// them; the reflector, which runs after that, writes its own down. What
// else runs after the reply is outside the meter and says so.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { dollars, tokensShort } from "@/lib/model-prices";
import { PageFrame } from "@/components/PageFrame";
import { Choices, adminError } from "@/components/AdminParts";
import { card, note } from "@/components/ui/controls";

type Agent = {
  name: string;
  about: string;
  runs: number;
  outcomes: Record<string, number>;
  /** One more figure where it says something: tries a design, repairs a repaired one. */
  note: string | null;
  calls: number;
  input: number;
  output: number;
  /** Null when none of its calls were metered. */
  usd: number | null;
};
type Agents = {
  since: string;
  agents: Agent[];
  roads: Array<{ road: string; turns: number; p50_ms: number | null; p90_ms: number | null }>;
};

const DAYS: Array<[number, string]> = [
  [1, "Today"],
  [7, "7 days"],
  [30, "30 days"],
];
const NAME: Record<string, string> = {
  plan: "Plan",
  design: "Design",
  validator: "Validator",
  critic: "Critic",
  gap: "Gap pass",
  memory: "Memory",
  reflect: "Reflect",
  judge: "Judge",
};
const ROAD: Record<string, string> = { talk: "Talk", design: "Design" };
// What each outcome means, by its tone; the numbers beside them say how many.
const GOOD = new Set(["understood", "designed", "passed", "fits", "nothing missing", "created", "addresses"]);
const BAD = new Set(["failed", "redo", "misses", "repeats"]);
const WARN = new Set(["repaired", "found missing", "asked back"]);
const toneOf = (k: string) =>
  GOOD.has(k)
    ? "bg-tone-success-fg"
    : BAD.has(k)
      ? "bg-tone-critical-fg"
      : WARN.has(k)
        ? "bg-tone-attention-fg"
        : "bg-tone-info-fg";
/** Nothing is "$0", not the four places a small reply needs. */
const money = (n: number) => (n === 0 ? "$0" : dollars(n));
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

export default function AgentsPage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<Agents | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_agents", { p_days: days });
    if (err) {
      setError(adminError(err, "0176"));
      return;
    }
    setError(null);
    setA(data as Agents);
  }, [days]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user || (!a && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-24 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Agents</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              How each of Luke&rsquo;s agents did: how often it ran, how its runs came out, and what it cost.
            </p>
          </div>
          <Choices options={DAYS} value={days} onChange={setDays} />
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {a && (
          <>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {a.agents.map((g) => (
                <li key={g.name} className={`${card} flex flex-col p-4`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-[13px] font-medium text-fg">{NAME[g.name] ?? g.name}</h2>
                    <span className="text-xs text-fg-muted tabular-nums">
                      {g.runs.toLocaleString()} {g.runs === 1 ? "run" : "runs"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-fg-muted">{g.about}</p>
                  <Split outcomes={g.outcomes} />
                  {g.note && <p className="mt-2 text-xs text-fg-faint">{g.note}</p>}
                  <div className="mt-auto flex flex-wrap justify-between gap-x-3 gap-y-1 pt-3 text-xs text-fg-faint tabular-nums">
                    <span className="text-fg">{g.usd === null ? "not metered" : money(Number(g.usd))}</span>
                    {(g.calls > 0 || g.usd !== null) && (
                      <span>
                        {g.calls.toLocaleString()} {g.calls === 1 ? "call" : "calls"}
                        {g.usd !== null && (
                          <>
                            {" "}
                            · {tokensShort(g.input)} in · {tokensShort(g.output)} out
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-fg-faint">
              Dollars and tokens are what the turn&rsquo;s meter counted; the reflector writes its own dollars down. The
              validator is code; memory and the judge run after the reply, outside the meter.
            </p>

            <div className={`${card} mt-4 overflow-hidden`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
                <div className="text-[13px] font-medium text-fg">Time a turn takes, by road</div>
                <div className="text-xs text-fg-faint">half are quicker than p50, nine in ten than p90</div>
              </div>
              {a.roads.length === 0 ? (
                <p className="px-5 py-4 text-[13px] text-fg-muted">No turns in this time.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {a.roads.map((r) => (
                    <li key={r.road} className="flex items-baseline gap-3 px-5 py-2.5 text-[13px] tabular-nums">
                      <span className="min-w-0 flex-1 truncate text-fg">{ROAD[r.road] ?? r.road}</span>
                      <span className="text-xs text-fg-faint">
                        {r.turns.toLocaleString()} {r.turns === 1 ? "turn" : "turns"}
                      </span>
                      <span className="w-20 text-right text-fg">
                        <span className="text-xs text-fg-faint">p50 </span>
                        {r.p50_ms === null ? "–" : seconds(r.p50_ms)}
                      </span>
                      <span className="w-20 text-right text-fg">
                        <span className="text-xs text-fg-faint">p90 </span>
                        {r.p90_ms === null ? "–" : seconds(r.p90_ms)}
                      </span>
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

/** How an agent's runs came out: one bar of their shares, and each outcome named and counted under it, which is what a screen reader reads. */
function Split({ outcomes }: { outcomes: Record<string, number> }) {
  const parts = Object.entries(outcomes ?? {}).map(([k, n]) => [k, Number(n) || 0] as const);
  const total = parts.reduce((s, [, n]) => s + n, 0);
  return (
    <div className="mt-3">
      <div className="flex h-2 gap-px overflow-hidden rounded-full bg-surface-subdued" aria-hidden>
        {parts.map(
          ([k, n]) =>
            n > 0 && (
              <div key={k} className={toneOf(k)} style={{ width: `${(n / total) * 100}%` }} title={`${k}: ${n}`} />
            )
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
        {parts.map(([k, n]) => (
          <li key={k} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${toneOf(k)}`} />
            {k}
            <span className="text-fg tabular-nums">{n.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
