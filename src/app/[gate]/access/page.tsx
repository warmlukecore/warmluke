"use client";

// ─────────────────────────────────────────────────────────────
// Access log — what administrators did, across every account (0159).
//
// Each line of the audit trail: who acted, on whose account, and what
// changed, newest first. Reading a conversation is on it as well, as
// support access is. Filter by kind, find by either address, and load
// older lines as far back as the window reaches.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useConsoleScope } from "@/lib/console-scope";
import { Select } from "@/components/ui/Select";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { PageFrame } from "@/components/PageFrame";
import { Choices, adminError, panelScroll } from "@/components/AdminParts";
import { button, card, field, note } from "@/components/ui/controls";

type Line = {
  id: number;
  created_at: string;
  action: string;
  old_value: Record<string, unknown>;
  new_value: Record<string, unknown>;
  actor_id: string;
  actor: string | null;
  target_id: string;
  target: string | null;
};

/** 0158's check on admin_account_audit.action, as the middle of "who … whose". */
const ACTIONS: Record<string, string> = {
  set_feature: "changed a feature",
  set_turns: "changed turns",
  set_unlimited: "changed unlimited",
  reset_turns: "reset turns",
  suspend: "suspended",
  restore: "restored",
  delete: "deleted the account",
  set_luke: "changed Luke's models",
  set_tester: "changed the testing team",
  set_luke_test: "changed Luke test",
  view_conversation: "read a conversation",
  rename: "renamed",
};
/** An action's words; one added since this list, by its own name ("set_x" as "set x"). */
const words = (k: string) => ACTIONS[k] ?? k.replaceAll("_", " ");
const chip = (k: string) => words(k).charAt(0).toUpperCase() + words(k).slice(1);
const DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "A year"],
];
const PAGE = 100;

const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** The keys whose value changed, as "key: before → after". */
function changes(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) =>
      k in (before ?? {}) ? `${k}: ${shown(before[k])} → ${shown(after?.[k])}` : `${k}: ${shown(after[k])}`
    );
}

export default function AccessLog() {
  const { user, loading } = useUser();
  const router = useRouter();
  const gate = useParams<{ gate: string }>().gate;
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Line[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [action, setAction] = useState("");
  // Which administrator acted, and on whose account (0184).
  const [admin, setAdmin] = useState("");
  const [admins, setAdmins] = useState<Array<{ id: string; email: string | null }>>([]);
  const scope = useConsoleScope();
  const [days, setDays] = useState(30);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  // Older pages start before the last line shown; two lines in the same
  // microsecond across that edge would lose one, which is not a worry.
  const load = useCallback(
    async (before: string | null) => {
      const { data, error: err } = await supabase.rpc("abo_admin_access_log", {
        p_query: asked || null,
        p_action: action || null,
        p_days: days,
        p_limit: PAGE,
        p_before: before,
        p_account: scope.account,
        p_admin: admin || null,
      });
      if (err) {
        setError(adminError(err, "0159"));
        return;
      }
      const out = data as {
        rows: Line[];
        actions: Record<string, number>;
        admins?: Array<{ id: string; email: string | null }>;
      };
      setAdmins(out.admins ?? []);
      setError(null);
      setNow(Date.now());
      setCounts(out.actions);
      setRows((had) => (before && had ? [...had, ...out.rows] : out.rows));
      setMore(out.rows.length === PAGE);
    },
    [asked, action, days, admin, scope]
  );

  useEffect(() => {
    if (user) load(null);
  }, [user, load]);

  if (loading || !user || (!rows && !error)) {
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
  const kinds: Array<[string, string]> = [
    ["", "Everything"],
    // Every action the log has, a new one too, and the one chosen.
    ...[...new Set([...Object.keys(ACTIONS), ...Object.keys(counts)])]
      .filter((k) => counts[k] || k === action)
      .map((k): [string, string] => [k, `${chip(k)} · ${counts[k] ?? 0}`]),
  ];
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Access log</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          What administrators did, on whose account, and what it changed. Reading a conversation is written here too.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {rows && (
          <>
            <form
              className="mt-5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setAsked(query.trim());
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden
                  size={15}
                  strokeWidth={1.75}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint"
                />
                <input
                  className={`${field} pl-9`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="The administrator's or the account's email"
                  aria-label="Find by email"
                  spellCheck={false}
                />
              </div>
              <button type="submit" className={button("primary")}>
                Find
              </button>
            </form>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Choices options={DAYS} value={days} onChange={setDays} />
              <Choices options={kinds} value={action} onChange={setAction} />
              {admins.length > 0 && (
                <div className="w-64 max-w-full">
                  <Select
                    label="Administrator"
                    value={admin}
                    options={admins.map((x) => ({ value: x.id, label: x.email ?? "an administrator" }))}
                    empty="Every administrator"
                    onChange={setAdmin}
                  />
                </div>
              )}
              {rows.length > 0 && (
                <span className="ml-auto text-xs text-fg-faint tabular-nums" aria-live="polite">
                  {rows.length.toLocaleString()} {rows.length === 1 ? "entry" : "entries"}
                  {more ? ", older below" : ""}
                </span>
              )}
            </div>

            <div className={`${card} ${panelScroll} mt-4`}>
              {rows.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-fg-muted">Nothing in this window.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {rows.map((l) => {
                    const seen = l.action === "view_conversation" ? String(l.new_value?.conversation ?? "") : "";
                    const what = seen ? [] : changes(l.old_value, l.new_value);
                    return (
                      <li key={l.id} className="grid gap-1 px-5 py-3 text-[13px] sm:grid-cols-[9rem_minmax(0,1fr)]">
                        <span className="text-xs text-fg-faint" title={new Date(l.created_at).toLocaleString()}>
                          {ago(l.created_at, now)}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-1.5">
                            <span className="font-medium text-fg">{l.actor ?? "An account since deleted"}</span>
                            <span className="text-fg-muted">{words(l.action)}</span>
                            <span className="text-fg-muted">{seen ? "of" : "for"}</span>
                            <span className="truncate text-fg">{l.target ?? "an account since deleted"}</span>
                          </div>
                          {seen && (
                            <Link
                              href={`/${gate}/conversations?id=${seen}`}
                              className="mt-0.5 inline-block font-mono text-xs text-link hover:underline"
                            >
                              {seen}
                            </Link>
                          )}
                          {what.length > 0 && (
                            <ul className="mt-0.5 space-y-0.5">
                              {what.slice(0, 4).map((c) => (
                                <li key={c} className="truncate font-mono text-xs text-fg-muted" title={c}>
                                  {c}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {more && (
              <div className="mt-4 flex justify-center">
                <button onClick={() => load(rows.at(-1)?.created_at ?? null)} className={button("secondary", "sm")}>
                  Older
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </PageFrame>
  );
}
