"use client";

// ─────────────────────────────────────────────────────────────
// The screen where a merchant lets their own AI read their store.
//
// Supabase runs the OAuth server; this is the one part it cannot
// provide, because only we know what "read your store" means here. A
// client like ChatGPT registers itself, sends the merchant to Supabase,
// and Supabase sends them here with an authorization_id.
//
// The client's name and destination come back from Supabase, never
// from the caller. A page that printed a name the caller supplied
// would let anyone put "Claude" on a consent screen.
// ─────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase-client";

type Details = {
  authorization_id: string;
  redirect_uri: string;
  client: { name?: string | null; client_id?: string | null };
  scope: string;
};

/** What a scope actually lets them do, in the merchant's terms. */
const SCOPE_TEXT: Record<string, string> = {
  openid: "Know that it is you signing in",
  email: "See your email address",
  profile: "See your name",
  phone: "See your phone number",
  offline_access: "Keep reading after you close the page, until you disconnect it",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        {children}
      </div>
    </div>
  );
}

function ConsentInner() {
  const params = useSearchParams();
  const authorizationId = params.get("authorization_id");

  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!authorizationId) {
        setError(
          "This link is missing its authorization. Start again from the app you're connecting."
        );
        setLoading(false);
        return;
      }

      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Back here afterwards, not to the dashboard: the merchant is
        // mid-way through connecting something, and sending them
        // elsewhere loses the request entirely.
        const back = `${window.location.pathname}${window.location.search}`;
        window.location.href = `/login?next=${encodeURIComponent(back)}`;
        return;
      }

      const { data, error: err } =
        await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      // Already agreed to this before: Supabase hands back the finished
      // redirect and there is nothing left to ask.
      if (data && "redirect_url" in data) {
        window.location.href = data.redirect_url;
        return;
      }
      setDetails(data as Details);
      setLoading(false);
    })();
  }, [authorizationId]);

  const decide = useCallback(
    async (approve: boolean) => {
      if (!authorizationId || busy) return;
      setBusy(approve ? "approve" : "deny");
      setError(null);
      const { data, error: err } = approve
        ? await supabase.auth.oauth.approveAuthorization(authorizationId)
        : await supabase.auth.oauth.denyAuthorization(authorizationId);
      if (err || !data?.redirect_url) {
        setBusy(null);
        setError(err?.message ?? "That didn't go through. Try again.");
        return;
      }
      window.location.href = data.redirect_url;
    },
    [authorizationId, busy]
  );

  if (loading) {
    return (
      <Shell>
        <p className="text-sm text-slate-400">Checking the request…</p>
      </Shell>
    );
  }

  if (error || !details) {
    return (
      <Shell>
        <p className="text-sm text-rose-300">{error ?? "That request couldn't be read."}</p>
      </Shell>
    );
  }

  const name = details.client?.name?.trim() || "An application";
  const scopes = details.scope.split(/\s+/).filter(Boolean);
  // The host, not the whole URL: a merchant can recognise a domain, and
  // a long path is where a lookalike hides.
  let host = details.redirect_uri;
  try {
    host = new URL(details.redirect_uri).host;
  } catch {
    /* shown as given if it will not parse */
  }

  return (
    <Shell>
      <h1 className="font-display text-xl font-semibold text-white">
        {name} wants access to your store
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        It will be able to see your Shopify products, customers and orders through
        Warmluke, and to ask for changes: to this app, and to your shop.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Asking is all it can do. A change to your shop waits for you to agree to it
        here, every time, and it cannot agree for you. A change to this app waits the
        same way, unless you have turned on automatic builds.
      </p>

      <ul className="mt-5 space-y-1.5">
        {scopes.map((s) => (
          <li key={s} className="flex gap-2 text-sm text-slate-300">
            <span className="text-slate-600">·</span>
            <span>{SCOPE_TEXT[s] ?? s}</span>
          </li>
        ))}
      </ul>

      <p className="mt-5 text-xs text-slate-500">
        Sends you back to <span className="text-slate-400">{host}</span>. If you don&rsquo;t
        recognise that, say no.
      </p>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => decide(true)}
          disabled={!!busy}
          className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "approve" ? "Allowing…" : "Allow"}
        </button>
        <button
          onClick={() => decide(false)}
          disabled={!!busy}
          className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === "deny" ? "…" : "No"}
        </button>
      </div>
    </Shell>
  );
}

export default function Consent() {
  return (
    <Suspense
      fallback={
        <Shell>
          <p className="text-sm text-slate-400">Loading…</p>
        </Shell>
      }
    >
      <ConsentInner />
    </Suspense>
  );
}
