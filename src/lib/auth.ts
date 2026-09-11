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
  method: "POST" | "PATCH" | "DELETE" = "POST",
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
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data: json };
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
