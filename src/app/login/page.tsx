"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CenteredCard } from "@/components/CenteredCard";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { button, field, label, note } from "@/components/ui/controls";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { takePendingPrompt } from "@/lib/auth";
import { ownPath } from "@/lib/paths";

export default function Login() {
  const router = useRouter();
  // An invite link lands here when signed out; it has to survive the
  // detour, or the invited person arrives at a dashboard with nothing
  // in it and no way back to the app they were sent to.
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    setNext(new URLSearchParams(window.location.search).get("next"));
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (ownPath(next)) {
      router.replace(next);
    } else if (takePendingPrompt()) {
      router.replace("/dashboard?build=1");
    } else {
      router.replace("/dashboard");
    }
  }

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold tracking-tight text-fg">Welcome back</h1>
      <p className="mt-1">Sign in to your workspaces.</p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={label}>
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
            placeholder="you@company.com"
          />
        </div>
        <div>
          {/* Beside the field, not buried at the bottom: this is
              looked for at the moment the password fails. */}
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor="password" className="text-[13px] font-medium text-fg">
              Password
            </label>
            <Link href="/forgot" className="text-xs text-link hover:underline">
              Forgotten?
            </Link>
          </div>
          <PasswordInput
            id="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div role="alert" className={note.critical}>
            {error}
          </div>
        )}
        <button type="submit" disabled={busy} className={`${button("primary", "lg")} w-full`}>
          {busy ? "Signing in\u2026" : "Sign in"}
        </button>
      </form>

      <p className="mt-5 border-t border-line pt-4 text-center text-xs">
        No account?{" "}
        <Link
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
          className="font-medium text-link hover:underline"
        >
          Start free
        </Link>
      </p>
    </CenteredCard>
  );
}
