"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import type { User } from "@supabase/supabase-js";

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { user, loading };
}

export async function requireUser(router: ReturnType<typeof useRouter>): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    router.replace("/login");
    return null;
  }
  return data.user;
}

/** What went wrong signing in or up, said the way a person would want to hear it. */
export type AuthProblem = { message: string; exists?: boolean };

/**
 * Supabase's auth errors, in plain words. The raw ones read "User is
 * banned" to someone who was suspended and "Failed to fetch" to someone
 * whose wifi dropped. `exists` marks the one a sign-up form turns into a
 * way to sign in instead.
 */
export function authMessage(
  error: { message?: string; status?: number; code?: string } | null | undefined
): AuthProblem {
  const raw = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (typeof navigator !== "undefined" && !navigator.onLine)
    return { message: "You’re offline. Check your connection and try again." };
  if (/failed to fetch|network|load failed/.test(raw))
    return { message: "Warmluke couldn’t be reached. Check your connection and try again." };
  if (/banned/.test(raw)) return { message: "This account is suspended. Write to us if you think that’s a mistake." };
  if (/already (been )?registered|user_already_exists|email_exists/.test(raw)) {
    return { message: "There’s already an account with this email.", exists: true };
  }
  if (/invalid login credentials|invalid_credentials/.test(raw))
    return { message: "That email and password don’t match an account." };
  if (/email not confirmed/.test(raw)) return { message: "Confirm your email first; the link is in your inbox." };
  if (/password/.test(raw) && /(weak|short|least|characters)/.test(raw))
    return { message: "Choose a longer password: at least 8 characters." };
  if (/rate limit|too many|over_request_rate_limit|429/.test(raw) || error?.status === 429) {
    return { message: "Too many tries just now. Wait a minute and try again." };
  }
  return { message: error?.message || "Something went wrong. Try again." };
}

export async function signOut(router: ReturnType<typeof useRouter>) {
  await supabase.auth.signOut();
  router.replace("/");
}

/** fetch that attaches the user's access token so API routes run under their RLS. */
export async function apiFetch(
  path: string,
  body: unknown,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "POST",
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // A GET with a body is refused by fetch itself, and a read has
    // nothing to send anyway.
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data: json };
}

/**
 * apiFetch for a route that answers in lines (application/x-ndjson):
 * each line with a `step` goes to `onStep` as it arrives; the last
 * line, without one, is the answer and comes back exactly as apiFetch
 * would have returned it. A refusal that came back as plain JSON is
 * returned as plain JSON, so the caller need not know which it got.
 */
export async function apiStream(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  onStep: (step: Record<string, unknown>) => void,
  /** The draft of what is being said, whole each time. Never the result. */
  /** The reply's words so far, and what is being written once they are done. */
  onWords?: (text: string, phase?: string) => void
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body || !res.headers.get("content-type")?.includes("x-ndjson")) {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data: json };
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let last: Record<string, unknown> | null = null;
  const take = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if ("step" in obj) onStep(obj);
    // A draft is never the last line's stand-in: a stream that ends on
    // one did not finish, and is said to have been cut short below.
    else if ("words" in obj)
      onWords?.(typeof obj.words === "string" ? obj.words : "", typeof obj.phase === "string" ? obj.phase : undefined);
    else last = obj;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  take(buffer);
  // A stream that ended without its last line did not finish: the
  // server went away mid-turn. Said so, rather than shown as a reply
  // that failed its checks.
  return {
    ok: res.ok,
    status: res.status,
    data: last ?? { error: "The connection dropped before Luke finished. Nothing was changed." },
  };
}

/** Pending first prompt saved before auth so signup → build is seamless. */
export function savePendingPrompt(text: string) {
  try {
    localStorage.setItem("abo_pending_prompt", text);
  } catch {
    /* ignore */
  }
}

export function takePendingPrompt(): string | null {
  try {
    const t = localStorage.getItem("abo_pending_prompt");
    if (t) localStorage.removeItem("abo_pending_prompt");
    return t;
  } catch {
    return null;
  }
}
