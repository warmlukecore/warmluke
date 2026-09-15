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
  is_superadmin: boolean;
  projects: number;
  stores: number;
  created_at: string;
};

export default function Admin() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    setRows((data ?? []) as Account[]);
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

  async function setTurns(row: Account, turns: number) {
    setBusy(row.user_id);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_set_turns", {
      p_user: row.user_id,
      p_turns: turns,
    });
    setBusy(null);
    if (err) {
      setError(err.message);
      return;
    }
    load();
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
                  <th className="px-4 py-2.5 font-medium">Free builds</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
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
                      {/* Used against granted. A trial extension should
                          be a number somebody types, not a migration. */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400">{r.turns_used} /</span>
                        <input
                          type="number"
                          min={0}
                          defaultValue={r.free_turns}
                          onBlur={(e) => {
                            const next = Number(e.target.value);
                            if (Number.isFinite(next) && next !== r.free_turns) setTurns(r, next);
                          }}
                          className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
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
          <span className="text-slate-400">Free builds</span> — turns of our own engine this
          account may spend, counted whether they came from the chat or from their Claude,
          because both run it. Reading a store and approving a design already made cost
          nothing and are never counted.
        </p>
      </main>
    </div>
  );
}
