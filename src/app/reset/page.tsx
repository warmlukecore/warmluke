"use client";

// ─────────────────────────────────────────────────────────────
// Setting a new password, arrived at from the email link.
//
// The link signs the person in before this page loads — that is what
// makes the change possible, and also why the page has to check for a
// session rather than assume one. A stale or reused link leaves no
// session, and a form that accepted a new password anyway would report
// success and change nothing.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";

/** Supabase's own floor. Said up front rather than after a rejection. */
const MIN_LENGTH = 6;

export default function Reset() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The recovery link is handled asynchronously by the client, so the
    // session may not exist on the first tick. Waiting for the event is
    // the difference between "your link expired" and simply being early.
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        setReady(ok);
      }
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) finish(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) finish(true);
    });
    const timer = setTimeout(() => finish(false), 3000);

    return () => {
      clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    // Checked as well as shown: a typo in a password you cannot read
    // locks you out of the account you were trying to recover.
    if (password !== again) {
      setError("Those two don't match.");
      return;
    }

    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    router.replace("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 text-base font-bold text-white">
            A
          </div>
          <span className="font-display text-lg font-semibold">Warmluke</span>
        </Link>

        {ready === null && <p className="text-center text-sm text-slate-400">Checking the link…</p>}

        {ready === false && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
            <h1 className="font-display text-xl font-semibold">That link has expired</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              A reset link works once and lasts an hour. Ask for a fresh one.
            </p>
            <Link
              href="/forgot"
              className="mt-5 inline-block text-sm font-medium text-blue-400 hover:text-blue-300"
            >
              Send another
            </Link>
          </div>
        )}

        {ready === true && (
          <>
            <h1 className="font-display text-center text-2xl font-bold tracking-tight">
              Set a new password
            </h1>

            <form onSubmit={submit} className="mt-6 space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
                  New password
                </label>
                <input
                  type="password"
                  required
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
                  Again
                </label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={again}
                  onChange={(e) => setAgain(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                />
              </div>

              {error && <div className="text-xs text-rose-400">{error}</div>}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save and sign in"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
