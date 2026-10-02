"use client";

// The superadmin console's address, for links to and inside it.
//
// Inside the console it is the address already in the bar ([gate]).
// Outside it, an administrator is told it once by the server
// (/api/console); nobody else is, so the header shows them nothing.
//
// Callers: src/components/PageFrame.tsx, src/app/dashboard/page.tsx,
// src/app/start/[token]/page.tsx, the console's own screens.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/auth";

/** Asked once a page load, whoever asks; asked again after a refusal. */
let told: Promise<string | null> | null = null;

/** The console's address from the server, or null for anyone who is not an administrator. */
export function askConsoleBase(): Promise<string | null> {
  told ??= apiFetch("/api/console", {}).then(({ ok, data }) => {
    const base = ok && typeof data.base === "string" ? data.base : null;
    if (base === null) told = null;
    return base;
  });
  return told;
}

export function useConsoleBase(isSuperadmin: boolean): string | null {
  const gate = useParams<{ gate?: string }>()?.gate;
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (gate || !isSuperadmin) return;
    let live = true;
    askConsoleBase().then((b) => {
      if (live) setBase(b);
    });
    return () => {
      live = false;
    };
  }, [gate, isSuperadmin]);
  return gate ? `/${gate}` : base;
}
