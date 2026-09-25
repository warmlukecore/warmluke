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
import { Mail } from "lucide-react";
import { CenteredCard } from "@/components/CenteredCard";
import { button, field, label, note } from "@/components/ui/controls";
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
    <CenteredCard>
      {sent ? (
        <div className="text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-fg">
            <Mail aria-hidden size={18} strokeWidth={1.75} />
          </span>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-fg">Check your email</h1>
          <p className="mt-2">
            If <span className="font-medium text-fg">{email.trim()}</span> has an account, a link to set a new password
            is on its way. It works once, and expires in an hour.
          </p>
          <Link href="/login" className={`${button("secondary")} mt-5 w-full`}>
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Forgotten your password</h1>
          <p className="mt-1">We&rsquo;ll email you a link to set a new one.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className={label}>
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className={field}
              />
            </div>

            {error && (
              <div role="alert" className={note.critical}>
                {error}
              </div>
            )}

            <button type="submit" disabled={busy || !email.trim()} className={`${button("primary", "lg")} w-full`}>
              {busy ? "Sending\u2026" : "Send the link"}
            </button>
          </form>

          <p className="mt-5 border-t border-line pt-4 text-center text-xs">
            Remembered it?{" "}
            <Link href="/login" className="font-medium text-link hover:underline">
              Sign in
            </Link>
          </p>
        </>
      )}
    </CenteredCard>
  );
}
