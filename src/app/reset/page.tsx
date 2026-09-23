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
import { CenteredCard } from "@/components/CenteredCard";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { button, label, note } from "@/components/ui/controls";
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
    <CenteredCard>
      {ready === null && (
        <p className="flex items-center justify-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-neutral" />
          Checking the link…
        </p>
      )}

      {ready === false && (
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-tight text-fg">That link has expired</h1>
          <p className="mt-2">A reset link works once and lasts an hour. Ask for a fresh one.</p>
          <Link href="/forgot" className={`${button("primary")} mt-5 w-full`}>
            Send another
          </Link>
        </div>
      )}

      {ready === true && (
        <>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Set a new password</h1>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="password" className={label}>
                New password
              </label>
              <PasswordInput
                id="password"
                required
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_LENGTH} characters`}
              />
            </div>
            <div>
              <label htmlFor="again" className={label}>
                Again
              </label>
              <PasswordInput
                id="again"
                required
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </div>

            {error && (
              <div role="alert" className={note.critical}>
                {error}
              </div>
            )}

            <button type="submit" disabled={busy} className={`${button("primary", "lg")} w-full`}>
              {busy ? "Saving\u2026" : "Save and sign in"}
            </button>
          </form>
        </>
      )}
    </CenteredCard>
  );
}
