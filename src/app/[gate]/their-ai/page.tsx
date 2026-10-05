"use client";

// ─────────────────────────────────────────────────────────────
// Their AI: what the merchant's own ChatGPT or Claude is told, and how
// its asks come out (0180).
//
// What it is told is read from the server the way their AI reads it: the
// how_to_help tool and the prompts list, so this is the guide as served,
// not a copy that could drift (lib/client-guide). The part about the
// merchant is the administrator's own here; each merchant's AI is told
// about theirs.
//
// How it went is read off every call an outside assistant made: by guide
// version (a new version whenever a shared rule, a tool's words or a
// prompt changes), by week and by tool. Their designs refused, the
// problems in each, the ones Luke changed before the merchant saw them,
// the free view edits, the designs they asked Luke for: whether a new
// guide moves those is the point. Calls are kept 30 days.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Breakdown, Choices, Stat, adminError } from "@/components/AdminParts";
import { card, note } from "@/components/ui/controls";

type Figures = {
  key?: string;
  calls: number;
  connects: number;
  accounts: number;
  designs: number;
  designs_refused: number;
  designs_luke_changed: number;
  problems_per_refusal: number | null;
  checks: number;
  luke_asked: number;
  free_edits: number;
  undone: number;
  errors: number;
  first: string | null;
  last: string | null;
};
type Report = {
  since: string;
  all: Figures | null;
  guides: Figures[];
  weeks: Figures[];
  tools: Array<Figures & { outcomes: Record<string, number> | null }>;
  requests: Record<string, number>;
};
type Told = { guide: string; version: string; prompts: Array<{ name: string; title?: string; description: string }> };

const DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
];
const pct = (n: number, of: number) => (of === 0 ? "–" : `${Math.round((n / of) * 100)}%`);
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–";

/** A call to the server as their AI makes it, with this session. */
async function asTheirAI(method: string, params: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch("/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

export default function TheirAIPage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);
  const [told, setTold] = useState<Told | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_their_ai", { p_days: days });
    if (err) {
      setError(adminError(err, "0180"));
      return;
    }
    setError(null);
    setR(data as Report);
  }, [days]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  // What is served, read as their AI reads it, once the report has said this is an administrator.
  const shown = !!r;
  useEffect(() => {
    if (!shown) return;
    void (async () => {
      const [guide, prompts] = await Promise.all([
        asTheirAI("tools/call", { name: "how_to_help", arguments: {} }),
        asTheirAI("prompts/list", {}),
      ]);
      try {
        const g = JSON.parse(String((guide.result?.content as Array<{ text: string }>)?.[0]?.text ?? ""));
        setTold({ guide: g.guide, version: g.version, prompts: (prompts.result?.prompts as Told["prompts"]) ?? [] });
      } catch {
        setTold(null);
      }
    })();
  }, [shown]);

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
  const all = r?.all;
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Their AI</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              What a merchant&rsquo;s own ChatGPT or Claude is told, and how its asks come out, by guide and by week.
            </p>
          </div>
          <Choices options={DAYS} value={days} onChange={setDays} />
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {r && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <Stat label="Connections" value={all?.connects ?? 0} sub={`${all?.accounts ?? 0} accounts`} />
              <Stat
                label="Designs their AI drew"
                value={all?.designs ?? 0}
                sub={
                  all?.designs
                    ? `${pct(all.designs_refused, all.designs)} refused, ${pct(all.designs_luke_changed, all.designs)} changed by Luke`
                    : "none yet"
                }
              />
              <Stat
                label="Free view edits"
                value={all?.free_edits ?? 0}
                sub={`and ${all?.luke_asked ?? 0} designs asked of Luke`}
              />
            </div>

            <Table
              title="By guide"
              about="A new guide whenever a shared rule, a tool's words or a prompt changes."
              first="Guide"
              rows={r.guides}
              current={told?.version}
            />
            <Table title="By week" about="Weeks from Monday, UTC." first="Week of" rows={r.weeks} />

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className={`${card} p-4`}>
                <div className="text-xs font-medium text-fg-muted">Each tool, and how its calls came out</div>
                {r.tools.length === 0 ? (
                  <div className="mt-2 text-[13px] text-fg-faint">No calls in this time.</div>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {r.tools.map((t) => (
                      <li key={t.key} className="text-xs">
                        <div className="flex justify-between gap-2">
                          <span className="font-medium text-fg">{t.key}</span>
                          <span className="text-fg-muted tabular-nums">{t.calls.toLocaleString()}</span>
                        </div>
                        <div className="text-fg-muted">
                          {Object.entries(t.outcomes ?? {})
                            .map(([o, n]) => `${o} ${n}`)
                            .join(" · ")}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Breakdown
                label="What the changes their AI asked for came to"
                counts={Object.entries(r.requests).toSorted((a, b) => b[1] - a[1])}
                empty="No changes asked for in this time."
              />
            </div>

            <div className={`${card} mt-4 p-5`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-medium text-fg">What their AI is told</h2>
                {told && <span className="font-mono text-xs text-fg-muted">guide {told.version}</span>}
              </div>
              <p className="mt-1 text-xs text-fg-muted">
                As served, when it connects and from how_to_help. Under THIS MERCHANT is your own app here; each
                merchant&rsquo;s AI is told about theirs.
              </p>
              {told ? (
                <>
                  <pre className="mt-3 max-h-96 overflow-auto rounded-control bg-surface-subdued p-3 text-xs leading-relaxed whitespace-pre-wrap text-fg">
                    {told.guide}
                  </pre>
                  <div className="mt-4 text-xs font-medium text-fg-muted">Ready-made asks it offers them</div>
                  <ul className="mt-1.5 divide-y divide-line">
                    {told.prompts.map((p) => (
                      <li key={p.name} className="py-2 text-[13px]">
                        <span className="text-fg">{p.title ?? p.name}</span>
                        <span className="text-fg-muted"> · {p.description}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-3 text-[13px] text-fg-faint">Reading it from the server…</p>
              )}
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}

/** The figures, a row each: a guide or a week. */
function Table({
  title,
  about,
  first,
  rows,
  current,
}: {
  title: string;
  about: string;
  first: string;
  rows: Figures[];
  current?: string;
}) {
  return (
    <div className={`${card} mt-4 overflow-hidden`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
        <h2 className="text-[13px] font-medium text-fg">{title}</h2>
        <span className="text-xs text-fg-faint">{about}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-fg-muted">No calls in this time.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs tabular-nums">
            <thead className="text-fg-muted">
              <tr className="border-b border-line">
                <th scope="col" className="px-5 py-2 font-medium">
                  {first}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Seen
                </th>
                {["Connections", "Designs", "Refused", "Problems each", "Luke changed", "Free edits"].map((h) => (
                  <th key={h} scope="col" className="px-2 py-2 text-right font-medium">
                    {h}
                  </th>
                ))}
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Errors
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-fg">
              {rows.map((g) => (
                <tr key={g.key}>
                  <td className="px-5 py-2 font-mono">
                    {g.key}
                    {current && g.key === current && <span className="ml-1.5 font-sans text-fg-muted">(now)</span>}
                  </td>
                  <td className="px-2 py-2 text-fg-muted">
                    {date(g.first)}–{date(g.last)}
                  </td>
                  <td className="px-2 py-2 text-right">{g.connects}</td>
                  <td className="px-2 py-2 text-right">{g.designs}</td>
                  <td className="px-2 py-2 text-right">{pct(g.designs_refused, g.designs)}</td>
                  <td className="px-2 py-2 text-right">{g.problems_per_refusal ?? "–"}</td>
                  <td className="px-2 py-2 text-right">{pct(g.designs_luke_changed, g.designs)}</td>
                  <td className="px-2 py-2 text-right">{g.free_edits}</td>
                  <td className="px-5 py-2 text-right">{g.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
