"use client";

// The console's scope (0184): everyone, one account (its owner's apps and
// the team in them), or one app of it. Kept in the address, so it stays as
// the screens change, survives a refresh and can be sent to someone; every
// report screen asks its database function for this scope alone.
//
// Callers: components/PageFrame.tsx (links, the bar), the console's report pages.

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { CONSOLE_NAV } from "@/lib/console-nav";

/** The console screens whose reports narrow to an account: those lib/console-nav marks `scoped`. */
export const SCOPED = new Set(CONSOLE_NAV.flatMap((g) => g.screens.filter((s) => s.scoped).map((s) => s.to)));

export type Scope = { account: string | null; app: string | null };

const UUID = /^[0-9a-f-]{36}$/i;

/** The scope the address holds; anything that is not an id is no scope. */
export function useConsoleScope(): Scope {
  const q = useSearchParams();
  const pick = (k: string) => {
    const v = q.get(k);
    return v && UUID.test(v) ? v : null;
  };
  const account = pick("account");
  const app = account ? pick("app") : null;
  // The same object while the scope holds, so a screen reads again only when it changes.
  return useMemo(() => ({ account, app }), [account, app]);
}

/** The scope as a report function takes it: null for everyone. */
export const scopeArgs = (s: Scope) => ({ p_account: s.account, p_app: s.app });

/** The scope as an address's query, "" for everyone. */
export function scopeQuery(s: Scope): string {
  if (!s.account) return "";
  const q = new URLSearchParams({ account: s.account });
  if (s.app) q.set("app", s.app);
  return `?${q}`;
}
