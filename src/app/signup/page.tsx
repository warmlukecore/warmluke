"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CenteredCard } from "@/components/CenteredCard";
import { useCaptcha } from "@/components/Captcha";
import { InviteOnly } from "@/components/InviteOnly";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { button, field, label, note } from "@/components/ui/controls";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { authMessage, takePendingPrompt } from "@/lib/auth";
import { ownPath } from "@/lib/paths";

export default function Signup() {
  const router = useRouter();
  // An invite link lands here when signed out; it has to survive the
  // detour, or the invited person arrives at a dashboard with nothing
  // in it and no way back to the app they were sent to.
  const [next, setNext] = useState<string | null>(null);
  // Invite only (0141): without an invite to go back to, there is no form,
  // only the way to ask for one. Null until read, so neither flashes.
  const [inviteOnly, setInviteOnly] = useState<boolean | null>(null);
  useEffect(() => {
    setNext(new URLSearchParams(window.location.search).get("next"));
    supabase
      .from("signup_gate")
      .select("invite_only")
      .maybeSingle()
      // A database without the gate yet is an open one.
      .then(({ data }) => setInviteOnly(data?.invite_only === true));
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The address already has an account: offer to sign in with it instead.
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const captcha = useCaptcha();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setExists(false);
    const captchaToken = await captcha.take();
    const { error } = await supabase.auth.signUp({ email, password, options: { captchaToken } });
    setBusy(false);
    if (error) {
      const problem = authMessage(error);
      setError(problem.message);
      setExists(!!problem.exists);
      return;
    }
    // Autoconfirm is on: the session exists immediately.
    if (ownPath(next)) {
      router.replace(next);
    } else if (takePendingPrompt()) {
      router.replace("/dashboard?build=1");
    } else {
      router.replace("/dashboard");
    }
  }

  // A team's link (/join) or an invite to start (/start) is an invitation.
  const invited = !!next && /^\/(join|start)\//.test(next);
  if (inviteOnly === null) return <CenteredCard>{null}</CenteredCard>;
  if (inviteOnly && !invited) return <InviteOnly />;

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold tracking-tight text-fg">
        {invited ? "Create your account" : "Start building free"}
      </h1>
      <p className="mt-1">Your own workspace, isolated and versioned.</p>

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
          <label htmlFor="password" className={label}>
            Password
          </label>
          <PasswordInput
            id="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>
        {error && (
          <div role="alert" className={note.critical}>
            {error}
            {exists && (
              <Link
                href={`/login?email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ""}`}
                className="ml-1 font-medium underline underline-offset-2"
              >
                Sign in instead
              </Link>
            )}
          </div>
        )}
        {captcha.box}
        <button type="submit" disabled={busy} className={`${button("primary", "lg")} w-full`}>
          {busy ? "Creating account\u2026" : "Create account"}
        </button>
        <p className="text-center text-[11px] leading-relaxed text-fg-muted">
          By creating an account you agree to the{" "}
          <Link href="/terms" className="text-link hover:underline">
            Terms
          </Link>{" "}
          and the{" "}
          <Link href="/privacy" className="text-link hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </form>

      <p className="mt-5 border-t border-line pt-4 text-center text-xs">
        Already have an account?{" "}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          className="font-medium text-link hover:underline"
        >
          Sign in
        </Link>
      </p>
    </CenteredCard>
  );
}
