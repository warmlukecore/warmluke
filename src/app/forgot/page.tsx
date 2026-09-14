"use client";

// ─────────────────────────────────────────────────────────────
// Asking for a password reset.
//
// The answer is the same whether the address has an account or not.
// Saying "no account with that email" turns this form into a way to
// find out who has signed up, and the person who really forgot their
// password learns nothing useful from the difference anyway.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset`,
    });
    setBusy(false);

    // A rate limit is worth saying out loud — otherwise the merchant
    // sits waiting for an email that was never sent.
    if (err && /rate|limit|too many/i.test(err.message)) {
      setError("Too many attempts. Wait a minute and try again.");
      return;
    }
    setSent(true);
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

        {sent ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
            <h1 className="font-display text-xl font-semibold">Check your email</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              If <span className="text-slate-300">{email.trim()}</span> has an account, a
              link to set a new password is on its way. It works once, and expires in an
              hour.
            </p>
            <Link
              href="/login"
              className="mt-5 inline-block text-sm font-medium text-blue-400 hover:text-blue-300"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="font-display text-center text-2xl font-bold tracking-tight">
              Forgotten your password
            </h1>
            <p className="mt-2 text-center text-sm text-slate-400">
              We&rsquo;ll email you a link to set a new one.
            </p>

            <form onSubmit={submit} className="mt-6 space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
                  Email
                </label>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                />
              </div>

              {error && <div className="text-xs text-rose-400">{error}</div>}

              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send the link"}
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-slate-400">
              Remembered it?{" "}
              <Link href="/login" className="font-medium text-blue-400 hover:text-blue-300">
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
