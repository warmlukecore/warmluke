"use client";

// ─────────────────────────────────────────────────────────────
// Every account, and which assistants it may use.
//
// Nothing here reaches past row-level security. The list and the
// switch are security definer functions that check the caller is an
// administrator first — a screen using a service-role key would end
// the one security model this app has, for every other code path as
// well as this one.
//
// A merchant who finds this URL therefore sees a refusal, not an empty
// page: an empty list would read as "no accounts yet" and send whoever
// is debugging in the wrong direction.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Switch } from "@/components/ui/Switch";
import { button, card, field, fieldOf, note } from "@/components/ui/controls";
import { quietClasses } from "@/lib/tone";
import {
  HEARD_OPTIONS,
  ORDER_OPTIONS,
  PLATFORM_OPTIONS,
  ROLE_OPTIONS,
  TEAM_OPTIONS,
  labelOf,
} from "@/lib/onboarding";
import { Search } from "lucide-react";
import { ago } from "@/lib/when";
import { Breakdown, Stat, siteLink, topCounts } from "@/components/AdminParts";

type Account = {
  user_id: string;
  email: string;
  chat_enabled: boolean;
  mcp_enabled: boolean;
  store_actions_enabled: boolean;
  free_turns: number;
  turns_used: number;
  turns_unlimited: boolean;
  is_superadmin: boolean;
  projects: number;
  stores: number;
  created_at: string;
  // What they said in onboarding (0112). Absent on a database that has
  // not had it yet, and null for an account that has not answered.
  full_name?: string | null;
  business_name?: string | null;
  role?: string | null;
  monthly_orders?: string | null;
  platform?: string | null;
  website?: string | null;
  team_size?: string | null;
  heard_from?: string | null;
  heard_from_detail?: string | null;
  onboarded_at?: string | null;
  last_sign_in_at?: string | null;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type PendingAction =
  | { kind: "turns"; row: Account; next: number }
  | { kind: "unlimited"; row: Account; next: boolean }
  | { kind: "reset"; row: Account };

const MAX_ALLOWANCE = 2_147_483_647;

function allowanceFrom(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_ALLOWANCE ? parsed : null;
}

export default function Admin() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [query, setQuery] = useState("");
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace("/login?next=/admin");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_accounts");
    if (err) {
      setError(err.code === "42501" ? "This page is for administrators." : err.message);
      setRows([]);
      return;
    }
    setError(null);
    const accounts = (data ?? []) as Account[];
    setRows(accounts);
    setDrafts(Object.fromEntries(accounts.map((row) => [row.user_id, String(row.free_turns)])));
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  // One switch at a time. They are independent — an account can have
  // both, either, or neither — so a single call setting the pair would
  // let a stale row overwrite the switch nobody touched.
  async function setFeature(
    row: Account,
    feature: "chat" | "mcp" | "store_actions",
    on: boolean
  ) {
    setBusy(row.user_id);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_set_feature", {
      p_user: row.user_id,
      p_feature: feature,
      p_on: on,
    });
    setBusy(null);
    if (err) {
      setError(err.message);
      return;
    }
    // Re-read rather than patch in place: what comes back is what the
    // database actually holds.
    load();
  }

  async function applyPending() {
    if (!pending) return;
    const action = pending;
    setBusy(action.row.user_id);
    setError(null);
    const result =
      action.kind === "turns"
        ? await supabase.rpc("abo_admin_set_turns", {
            p_user: action.row.user_id,
            p_turns: action.next,
          })
        : action.kind === "unlimited"
          ? await supabase.rpc("abo_admin_set_unlimited", {
              p_user: action.row.user_id,
              p_on: action.next,
            })
          : await supabase.rpc("abo_admin_reset_turns", {
              p_user: action.row.user_id,
            });
    setBusy(null);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setPending(null);
    await load();
  }

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          !q ||
          r.email.toLowerCase().includes(q) ||
          (r.full_name ?? "").toLowerCase().includes(q) ||
          (r.business_name ?? "").toLowerCase().includes(q)
      ),
    [rows, q]
  );

  // The numbers at the top, from the same rows as the table.
  const stats = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      onboarded: all.filter((r) => r.onboarded_at).length,
      withStore: all.filter((r) => r.stores > 0).length,
      thisWeek: all.filter((r) => now - Date.parse(r.created_at) < WEEK_MS).length,
      heard: topCounts(all.map((r) => labelOf(HEARD_OPTIONS, r.heard_from))),
    };
  }, [rows, now]);

  if (loading || !user || rows === null) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
          <div className="mt-6 h-64 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame email={user.email} isSuperadmin={!error}>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Accounts</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          Who is using Warmluke, what they told us, and which assistants are switched on for them.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {!error && rows.length === 0 && <p className="mt-6 text-[13px] text-fg-muted">No accounts yet.</p>}

        {rows.length > 0 && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Accounts" value={stats.total} sub={`${stats.thisWeek} new this week`} />
              <Stat label="Finished onboarding" value={stats.onboarded} sub={`of ${stats.total}`} />
              <Stat label="With a store connected" value={stats.withStore} sub={`of ${stats.total}`} />
              <Breakdown label="Where they heard of us" counts={stats.heard} empty="Nobody has said yet" />
            </div>

            <label className="relative mt-6 block max-w-xs">
              <Search aria-hidden size={15} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="Find by email, name or business"
                aria-label="Find an account"
                className={`${field} pl-8`}
              />
            </label>

            <div className={`${card} thin-scroll mt-3 overflow-x-auto`}>
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-surface-subdued text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Account</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Business</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Projects</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Stores</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Warmluke AI</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Their own AI</th>
                    {/* The one that reaches outside the building. Off for
                        everybody until somebody here decides otherwise,
                        which is why it needs a button rather than a row
                        of SQL somebody remembers. */}
                    <th className="px-3 py-2.5 font-medium first:pl-4">Change their shop</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Included designs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((r) => {
                    const draft = drafts[r.user_id] ?? String(r.free_turns);
                    const nextAllowance = allowanceFrom(draft);
                    const allowanceChanged =
                      nextAllowance !== null && nextAllowance !== r.free_turns;
                    const confirming = pending?.row.user_id === r.user_id ? pending : null;
                    const site = siteLink(r.website);
                    const facts = [
                      labelOf(ROLE_OPTIONS, r.role),
                      r.monthly_orders ? `${labelOf(ORDER_OPTIONS, r.monthly_orders)} orders/mo` : null,
                      labelOf(PLATFORM_OPTIONS, r.platform),
                      r.team_size ? `team ${labelOf(TEAM_OPTIONS, r.team_size)}` : null,
                    ].filter(Boolean);

                    return (
                    <tr key={r.user_id} className="align-top transition-colors hover:bg-surface-subdued/60">
                      <td className="px-3 py-3 first:pl-4">
                        <div className="flex items-start gap-2.5">
                          <span
                            aria-hidden
                            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${quietClasses(r.email)}`}
                          >
                            {(r.full_name || r.email).trim().charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="max-w-[14rem] truncate font-medium text-fg">{r.full_name || r.email}</span>
                              {r.is_superadmin && (
                                <span className="rounded-full bg-tone-neutral px-1.5 py-px text-[10px] font-medium text-tone-neutral-fg">
                                  admin
                                </span>
                              )}
                            </div>
                            {r.full_name && <div className="max-w-[14rem] truncate text-xs text-fg-muted">{r.email}</div>}
                            <div className="text-[11px] text-fg-faint">
                              Joined {new Date(r.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                              {" · "}
                              {ago(r.last_sign_in_at, now, "never signed in")}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 first:pl-4">
                        {r.business_name ? (
                          <div className="min-w-44 max-w-60">
                            <div className="truncate font-medium text-fg">{r.business_name}</div>
                            {facts.length > 0 && <div className="text-xs text-fg-muted">{facts.join(" · ")}</div>}
                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-faint">
                              {site && (
                                <a href={site.href} target="_blank" rel="noopener noreferrer nofollow" className="text-link hover:underline">
                                  {site.text}
                                </a>
                              )}
                              {r.heard_from && (
                                <span>
                                  via {labelOf(HEARD_OPTIONS, r.heard_from)}
                                  {r.heard_from_detail ? ` (${r.heard_from_detail})` : ""}
                                </span>
                              )}
                            </div>
                            {!r.onboarded_at && (
                              <span className="mt-1 inline-block rounded-full bg-tone-attention px-1.5 py-px text-[10px] font-medium text-tone-attention-fg">
                                Onboarding not finished
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="rounded-full bg-tone-neutral px-2 py-0.5 text-[11px] text-tone-neutral-fg">
                            Hasn&rsquo;t answered yet
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-fg-muted tabular-nums">{r.projects}</td>
                      <td className="px-3 py-3 text-fg-muted tabular-nums">{r.stores}</td>
                      {(["chat", "mcp", "store_actions"] as const).map((feature) => {
                        const on =
                          feature === "chat"
                            ? r.chat_enabled
                            : feature === "mcp"
                              ? r.mcp_enabled
                              : r.store_actions_enabled;
                        return (
                          <td key={feature} className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={on}
                                onChange={(next) => setFeature(r, feature, next)}
                                disabled={busy === r.user_id}
                                label={`${feature === "chat" ? "Warmluke AI" : feature === "mcp" ? "Their own AI" : "Changing their shop"} for ${r.email}`}
                              />
                              <span className={`text-xs ${on ? (feature === "store_actions" ? "font-medium text-tone-attention-fg" : "text-fg") : "text-fg-faint"}`}>
                                {on ? "On" : "Off"}
                              </span>
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-3 py-3 first:pl-4">
                        <div className="min-w-60 space-y-2">
                          {/* Used against granted. Editing only changes a
                              draft: spend controls should never save just
                              because somebody clicked elsewhere. */}
                          <div className="flex items-center gap-1.5">
                            {/* What they have spent, and the ceiling it is
                                spent against. With no cap the ceiling is
                                kept but does not apply, and saying "22 / 10"
                                beside "no cap" reads like a contradiction,
                                so the slash only appears when it means
                                something. */}
                            <span className="text-fg tabular-nums">{r.turns_used}</span>
                            <span className="text-fg-faint">
                              {r.turns_unlimited ? "used" : "/"}
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={MAX_ALLOWANCE}
                              step={1}
                              value={draft}
                              aria-label={`Included designs for ${r.email}`}
                              onChange={(e) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [r.user_id]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && allowanceChanged) {
                                  setPending({ kind: "turns", row: r, next: nextAllowance });
                                }
                                if (e.key === "Escape") {
                                  setDrafts((current) => ({
                                    ...current,
                                    [r.user_id]: String(r.free_turns),
                                  }));
                                }
                              }}
                              disabled={busy === r.user_id}
                              title={
                                r.turns_unlimited
                                  ? "Kept for when unlimited is switched off"
                                  : "Designs this account may spend in total"
                              }
                              className={`${fieldOf("sm")} w-20 tabular-nums ${r.turns_unlimited ? "opacity-60" : ""}`}
                            />
                            <button
                              type="button"
                              disabled={!allowanceChanged || busy === r.user_id}
                              onClick={() =>
                                nextAllowance !== null &&
                                setPending({ kind: "turns", row: r, next: nextAllowance })
                              }
                              className={button("secondary", "sm")}
                            >
                              Save
                            </button>
                            {/* The count only ever goes up, so the box is a
                                ceiling and not a grant. Say what remains
                                rather than making the admin do arithmetic. */}
                            <span
                              className={`text-xs ${
                                r.turns_unlimited
                                  ? "text-tone-success-fg"
                                  : r.free_turns - r.turns_used > 0
                                    ? "text-fg-muted"
                                    : "font-medium text-tone-attention-fg"
                              }`}
                            >
                              {r.turns_unlimited
                                ? "no cap"
                                : r.free_turns - r.turns_used > 0
                                  ? `${r.free_turns - r.turns_used} left`
                                  : "none left"}
                            </span>
                          </div>

                          {nextAllowance === null && (
                            <p className="text-[11px] text-tone-critical-fg">
                              Enter a whole number from 0 to {MAX_ALLOWANCE.toLocaleString()}.
                            </p>
                          )}

                          <div className="flex items-center gap-3 text-xs">
                            {/* The state is said, not only coloured. A
                                knob on a track reads as "on" to most
                                people, and the one person who uses this
                                screen read it that way, then asked why an
                                "unlimited" account still said "none left".
                                It was off, and every number on the row was
                                correct. */}
                            <span className="inline-flex items-center gap-2">
                              <Switch
                                checked={r.turns_unlimited}
                                onChange={(next) => setPending({ kind: "unlimited", row: r, next })}
                                disabled={busy === r.user_id}
                                label={`Unlimited included designs for ${r.email}`}
                              />
                              <span className={`whitespace-nowrap ${r.turns_unlimited ? "text-tone-success-fg" : "text-fg-muted"}`}>
                                Unlimited {r.turns_unlimited ? "on" : "off"}
                              </span>
                            </span>
                            {/* This was plain text, and plain text does not
                                look like something you may click; the
                                person who owns this screen asked to be
                                given the ability they already had. */}
                            {r.turns_used > 0 && (
                              <button
                                type="button"
                                disabled={busy === r.user_id}
                                onClick={() => setPending({ kind: "reset", row: r })}
                                title={`Set used back to 0 for ${r.email}`}
                                className={button("secondary", "sm")}
                              >
                                Reset used to 0
                              </button>
                            )}
                          </div>

                          {confirming && (
                            <div className={note.attention}>
                              <p>
                                {confirming.kind === "turns"
                                  ? `Set this account’s total allowance to ${confirming.next}?`
                                  : confirming.kind === "unlimited"
                                    ? confirming.next
                                      ? "Remove the included-design limit for this account?"
                                      : `Restore the finite limit of ${r.free_turns}?`
                                    : `Reset used designs from ${r.turns_used} to 0? This starts a fresh allowance.`}
                              </p>
                              <div className="mt-2 flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={applyPending}
                                  disabled={busy === r.user_id}
                                  className={button("primary", "sm")}
                                >
                                  {busy === r.user_id ? "Saving…" : "Confirm"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPending(null)}
                                  disabled={busy === r.user_id}
                                  className={button("plain", "sm")}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-[13px] text-fg-muted">
                        No account matches &ldquo;{query}&rdquo;.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">Warmluke AI</span> — the chat inside the app,
          whose model calls we pay for. <span className="font-medium text-fg">Their own AI</span>{" "}
          — their Claude or ChatGPT connected over MCP, which they pay for. The two are
          independent: either can be off, and an account with neither still has its app,
          its data, and every section already built.{" "}
          <span className="font-medium text-fg">Included designs</span> — designs Warmluke may
          produce for this account, whether requested in chat or through their Claude.
          Reading a store and building a design already made are never counted.
        </p>
      </div>
    </PageFrame>
  );
}
