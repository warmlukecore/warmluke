"use client";

// ─────────────────────────────────────────────────────────────
// Start — the link an administrator sends a customer (0119).
//
// The page asks the database about this one link (abo_invite_peek) and
// shows what it can: an account to make with the email, name and business
// the administrator already knew, or why the link no longer works. Once
// they are signed in, taking it (abo_invite_claim) is the database's call,
// never this page's; an invite made for one email is only theirs.
//
// What the invite knew goes into the account's details, where onboarding
// reads the name and business from, so the first question is already
// answered. Somebody who already has an account signs in and comes back
// here, and the link is taken the same way.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { authMessage } from "@/lib/auth";
import { CenteredCard } from "@/components/CenteredCard";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { button, field, label, note } from "@/components/ui/controls";

type Peek = {
  state: string;
  email: string | null;
  full_name: string | null;
  business_name: string | null;
  expires_at: string | null;
};

/** Why a link that is not open does not work, and what to do instead. */
const CLOSED: Record<string, { title: string; body: string }> = {
  expired: {
    title: "This invite has run out",
    body: "Ask whoever sent it for a fresh link. You can also sign up without one.",
  },
  used: { title: "This invite has already been used", body: "If that was you, sign in. If not, ask for a new link." },
  revoked: { title: "This invite was withdrawn", body: "Ask whoever sent it if you should have a new one." },
  unknown: { title: "This link isn’t an invite we know", body: "Check it was copied whole, or ask for a new one." },
  someone_else: {
    title: "This invite is for somebody else",
    body: "It was made for a different email. Sign out, and open it again with the address it was sent to.",
  },
};

const until = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

export default function StartPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  // True until the link is read and, for somebody signed in, taken.
  const [opening, setOpening] = useState(true);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Takes the link for whoever is signed in, and sends them on. */
  const claim = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("abo_invite_claim", { p_token: token });
    const row = (data as Array<{ state: string; full_name: string | null; business_name: string | null }> | null)?.[0];
    if (e || !row) {
      setError(authMessage(e).message);
      setBusy(false);
      setOpening(false);
      return;
    }
    if (row.state === "staff") {
      router.replace("/admin/invites");
      return;
    }
    if (row.state !== "claimed") {
      setClosed(row.state);
      setBusy(false);
      setOpening(false);
      return;
    }
    // What the invite knew, where onboarding looks for it; what they
    // already told us themselves is not overwritten.
    const { data: u } = await supabase.auth.getUser();
    const meta = (u.user?.user_metadata ?? {}) as { full_name?: string; business_name?: string };
    const fill: Record<string, string> = {};
    if (row.full_name && !meta.full_name) fill.full_name = row.full_name;
    if (row.business_name && !meta.business_name) fill.business_name = row.business_name;
    if (Object.keys(fill).length) await supabase.auth.updateUser({ data: fill });
    // The dashboard decides whether onboarding is still to do.
    router.replace("/dashboard");
  }, [token, router]);

  useEffect(() => {
    (async () => {
      const { data, error: e } = await supabase.rpc("abo_invite_peek", { p_token: token });
      const row = (data as Peek[] | null)?.[0];
      if (e || !row) {
        // A link we could not ask about is not the same as a bad link.
        if (e) setError(authMessage(e).message);
        else setClosed("unknown");
        setOpening(false);
        return;
      }
      if (row.state !== "open") {
        setClosed(row.state);
        setOpening(false);
        return;
      }
      setPeek(row);
      setEmail(row.email ?? "");
      const { data: s } = await supabase.auth.getSession();
      if (s.session) {
        await claim();
        return;
      }
      setOpening(false);
    })();
  }, [token, claim]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setExists(false);
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          ...(peek?.full_name ? { full_name: peek.full_name } : {}),
          ...(peek?.business_name ? { business_name: peek.business_name } : {}),
        },
      },
    });
    if (err || !data.session) {
      const problem = authMessage(err);
      setError(problem.message);
      setExists(!!problem.exists);
      setBusy(false);
      return;
    }
    await claim();
  }

  const back = `/start/${token}`;

  if (opening) {
    return (
      <CenteredCard>
        <div className="flex items-center justify-center gap-2 text-[13px] text-fg-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-neutral" />
          Opening your invite…
        </div>
      </CenteredCard>
    );
  }

  if (closed || !peek) {
    const c = CLOSED[closed ?? "unknown"] ?? CLOSED.unknown;
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold text-fg">
          {error && !closed ? "The invite couldn’t be opened" : c.title}
        </h1>
        <p className="mt-1 text-[13px] text-fg-muted">{error && !closed ? error : c.body}</p>
        <div className="mt-5 flex gap-2">
          {closed === "someone_else" ? (
            <button
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.replace(back);
              }}
              className={button("primary")}
            >
              Sign out
            </button>
          ) : error && !closed ? (
            <button onClick={() => window.location.reload()} className={button("primary")}>
              Try again
            </button>
          ) : (
            <>
              <Link href="/login" className={button("primary")}>
                Sign in
              </Link>
              <Link href="/signup" className={button("secondary")}>
                Sign up
              </Link>
            </>
          )}
        </div>
      </CenteredCard>
    );
  }

  const named = !!peek.email;
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold tracking-tight text-fg">
        {peek.full_name ? `Welcome, ${peek.full_name.split(/\s+/)[0]}` : "You’re invited to Warmluke"}
      </h1>
      <p className="mt-1 text-[13px] text-fg-muted">
        {peek.business_name ? `Set up ${peek.business_name}’s workspace. ` : "Set up your workspace. "}
        It takes a minute.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={label}>
            Email
          </label>
          <div className="relative">
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              readOnly={named}
              aria-describedby={named ? "email-note" : undefined}
              className={`${field} ${named ? "pr-9 text-fg-muted" : ""}`}
              placeholder="you@company.com"
            />
            {named && (
              <Lock
                aria-hidden
                size={14}
                strokeWidth={1.75}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-fg-faint"
              />
            )}
          </div>
          {named && (
            <p id="email-note" className="mt-1 text-[11px] text-fg-faint">
              This invite is for this address.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="password" className={label}>
            Choose a password
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
                href={`/login?email=${encodeURIComponent(email.trim())}&next=${encodeURIComponent(back)}`}
                className="ml-1 font-medium underline underline-offset-2"
              >
                Sign in instead
              </Link>
            )}
          </div>
        )}
        <button type="submit" disabled={busy} className={`${button("primary", "lg")} w-full`}>
          {busy ? "Setting up…" : "Create my account"}
        </button>
      </form>

      <p className="mt-5 border-t border-line pt-4 text-center text-xs text-fg-muted">
        {peek.expires_at && <>This invite works until {until(peek.expires_at)}. </>}
        Already have an account?{" "}
        <Link
          href={`/login?${named ? `email=${encodeURIComponent(peek.email ?? "")}&` : ""}next=${encodeURIComponent(back)}`}
          className="font-medium text-link hover:underline"
        >
          Sign in
        </Link>
      </p>
    </CenteredCard>
  );
}
