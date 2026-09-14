"use client";

// ─────────────────────────────────────────────────────────────
// Every account, and which assistant it uses.
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
  assistant: "ours" | "theirs";
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

  async function setAssistant(row: Account, assistant: "ours" | "theirs") {
    setBusy(row.user_id);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_set_assistant", {
      p_user: row.user_id,
      p_assistant: assistant,
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
            Who is using Warmluke, and whose assistant they run on.
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
                  <th className="px-4 py-2.5 font-medium">Assistant</th>
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
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {(["ours", "theirs"] as const).map((value) => (
                          <button
                            key={value}
                            onClick={() => setAssistant(r, value)}
                            disabled={busy === r.user_id || r.assistant === value}
                            className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                              r.assistant === value
                                ? "bg-blue-600 text-white"
                                : "border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                            }`}
                          >
                            {value === "ours" ? "Ours" : "Their own AI"}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          <span className="text-slate-400">Ours</span> — the built-in assistant, and we pay
          for the model calls. <span className="text-slate-400">Their own AI</span> — the
          builder is replaced by instructions for connecting their Claude or ChatGPT over
          MCP. Their data and their apps are untouched either way.
        </p>
      </main>
    </div>
  );
}
