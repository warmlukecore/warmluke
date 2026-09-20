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
  onStep: (step: Record<string, unknown>) => void
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
