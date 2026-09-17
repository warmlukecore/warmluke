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

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";

type Account = {
  user_id: string;
  email: string;
  chat_enabled: boolean;
  mcp_enabled: boolean;
  free_turns: number;
  turns_used: number;
  turns_unlimited: boolean;
  is_superadmin: boolean;
  projects: number;
  stores: number;
  created_at: string;
};

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
  async function setFeature(row: Account, feature: "chat" | "mcp", on: boolean) {
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

  if (loading || !user || rows === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Accounts</h1>
          <p className="mt-1 text-sm text-slate-400">
            Who is using Warmluke, and which assistants are switched on for them.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-900"
        >
          Back
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
        {error && (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {!error && rows.length === 0 && <div className="text-sm text-slate-500">No accounts yet.</div>}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900/60 text-[11px] tracking-wide text-slate-400 uppercase">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Account</th>
                  <th className="px-4 py-2.5 font-medium">Projects</th>
                  <th className="px-4 py-2.5 font-medium">Stores</th>
                  <th className="px-4 py-2.5 font-medium">Warmluke AI</th>
                  <th className="px-4 py-2.5 font-medium">Their own AI</th>
                  <th className="px-4 py-2.5 font-medium">Included designs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const draft = drafts[r.user_id] ?? String(r.free_turns);
                  const nextAllowance = allowanceFrom(draft);
                  const allowanceChanged =
                    nextAllowance !== null && nextAllowance !== r.free_turns;
                  const confirming = pending?.row.user_id === r.user_id ? pending : null;

                  return (
                  <tr key={r.user_id} className="border-t border-slate-800">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-200">{r.email}</span>
                        {r.is_superadmin && (
                          <span className="rounded bg-slate-800 px-1.5 py-px text-[10px] tracking-wide text-slate-400 uppercase">
                            admin
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Joined {new Date(r.created_at).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{r.projects}</td>
                    <td className="px-4 py-3 text-slate-400">{r.stores}</td>
                    {(["chat", "mcp"] as const).map((feature) => {
                      const on = feature === "chat" ? r.chat_enabled : r.mcp_enabled;
                      return (
                        <td key={feature} className="px-4 py-3">
                          <button
                            onClick={() => setFeature(r, feature, !on)}
                            disabled={busy === r.user_id}
                            className={`rounded-lg px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                              on
                                ? "bg-blue-600 text-white hover:bg-blue-700"
                                : "border border-slate-700 text-slate-500 hover:bg-slate-800"
                            }`}
                          >
                            {on ? "On" : "Off"}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3">
                      <div className="min-w-72 space-y-2">
                        {/* Used against granted. Editing only changes a
                            draft: spend controls should never save just
                            because somebody clicked elsewhere. */}
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400">{r.turns_used} /</span>
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
                            className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500 disabled:opacity-40"
                          />
                          <button
                            type="button"
                            disabled={!allowanceChanged || busy === r.user_id}
                            onClick={() =>
                              nextAllowance !== null &&
                              setPending({ kind: "turns", row: r, next: nextAllowance })
                            }
                            className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            Save
                          </button>
                          {/* The count only ever goes up, so the box is a
                              ceiling and not a grant. Say what remains
                              rather than making the admin do arithmetic. */}
                          <span
                            className={
                              r.turns_unlimited
                                ? "text-emerald-400"
                                : r.free_turns - r.turns_used > 0
                                  ? "text-slate-500"
                                  : "text-amber-500"
                            }
                          >
                            {r.turns_unlimited
                              ? "no cap"
                              : r.free_turns - r.turns_used > 0
                                ? `${r.free_turns - r.turns_used} left`
                                : "none left"}
                          </span>
                        </div>

                        {nextAllowance === null && (
                          <p className="text-[11px] text-rose-400">
                            Enter a whole number from 0 to {MAX_ALLOWANCE.toLocaleString()}.
                          </p>
                        )}

                        <div className="flex items-center gap-3 text-[11px]">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={r.turns_unlimited}
                            aria-label={`Unlimited included designs for ${r.email}`}
                            disabled={busy === r.user_id}
                            onClick={() =>
                              setPending({
                                kind: "unlimited",
                                row: r,
                                next: !r.turns_unlimited,
                              })
                            }
                            className="inline-flex items-center gap-1.5 text-slate-400 disabled:opacity-40"
                          >
                            <span
                              className={`relative h-4 w-7 rounded-full border transition-colors ${
                                r.turns_unlimited
                                  ? "border-emerald-400 bg-emerald-500"
                                  : "border-slate-600 bg-slate-800"
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-3 w-3 rounded-full transition-transform ${
                                  r.turns_unlimited
                                    ? "translate-x-3.5 bg-white"
                                    : "translate-x-0.5 bg-slate-400"
                                }`}
                              />
                            </span>
                            {/* The state is said, not only coloured. A
                                white knob on a dark track reads as "on"
                                to most people, and the one person who
                                uses this screen read it that way — then
                                asked why an "unlimited" account still
                                said "none left". It was off, and every
                                number on the row was correct. */}
                            <span className={r.turns_unlimited ? "text-emerald-400" : "text-slate-500"}>
                              Unlimited {r.turns_unlimited ? "on" : "off"}
                            </span>
                          </button>
                          {r.turns_used > 0 && (
                            <button
                              type="button"
                              disabled={busy === r.user_id}
                              onClick={() => setPending({ kind: "reset", row: r })}
                              className="text-slate-500 hover:text-amber-400 disabled:opacity-40"
                            >
                              Reset used
                            </button>
                          )}
                        </div>

                        {confirming && (
                          <div className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-2.5">
                            <p className="text-[11px] leading-relaxed text-amber-100">
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
                                className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
                              >
                                {busy === r.user_id ? "Saving…" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPending(null)}
                                disabled={busy === r.user_id}
                                className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-40"
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
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          <span className="text-slate-400">Warmluke AI</span> — the chat inside the app,
          whose model calls we pay for. <span className="text-slate-400">Their own AI</span>{" "}
          — their Claude or ChatGPT connected over MCP, which they pay for. The two are
          independent: either can be off, and an account with neither still has its app,
          its data, and every section already built.{" "}
          <span className="text-slate-400">Included designs</span> — designs Warmluke may
          produce for this account, whether requested in chat or through their Claude.
          Reading a store and building a design already made are never counted.
        </p>
      </main>
    </div>
  );
}
