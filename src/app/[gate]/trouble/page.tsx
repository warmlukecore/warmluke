"use client";

// ─────────────────────────────────────────────────────────────
// Needs a look: where something went wrong, found in what the app keeps
// (0175), so it is seen the day it happens and not when an owner writes
// in. Luke's turns that failed or were sent back, an owner saying it went
// wrong, a section changed again and again, a rule failing, and designs
// that look like a way round the app. Each says where to look.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { PageFrame } from "@/components/PageFrame";
import { Choices, adminError } from "@/components/AdminParts";
import { card, note } from "@/components/ui/controls";

type Sign = {
  kind: "turn" | "frustrated" | "churn" | "rule" | "workaround";
  at: string;
  detail: string;
  sample: string | null;
  conversation_id: string | null;
  project: string;
  title: string | null;
};

const DAYS: Array<[number, string]> = [
  [1, "Today"],
  [7, "7 days"],
  [30, "30 days"],
];
const KIND: Record<Sign["kind"], [string, string]> = {
  turn: ["Luke", "bg-tone-critical text-tone-critical-fg"],
  frustrated: ["Owner", "bg-tone-attention text-tone-attention-fg"],
  churn: ["Section", "bg-tone-info text-tone-info-fg"],
  rule: ["Rule", "bg-tone-critical text-tone-critical-fg"],
  workaround: ["Design", "bg-tone-warning text-tone-warning-fg"],
};

export default function TroublePage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const gate = useParams<{ gate: string }>().gate;
  const [error, setError] = useState<string | null>(null);
  const [signs, setSigns] = useState<Sign[] | null>(null);
  const [days, setDays] = useState(7);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_trouble", { p_days: days });
    if (err) {
      setError(adminError(err, "0175"));
      return;
    }
    setError(null);
    setSigns((data ?? []) as Sign[]);
    setNow(Date.now());
  }, [days]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user || (!signs && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Needs a look</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              Where something went wrong, found before anyone writes in. Newest first.
            </p>
          </div>
          <Choices options={DAYS} value={days} onChange={setDays} />
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {signs && signs.length === 0 && (
          <div className={`${card} mt-6 px-5 py-10 text-center text-[13px] text-fg-muted`}>
            Nothing needs a look in this time.
          </div>
        )}
        {signs && signs.length > 0 && (
          <ul className={`${card} mt-6 divide-y divide-line overflow-hidden`}>
            {signs.map((s, i) => (
              <li key={`${s.kind}-${s.at}-${i}`} className="flex items-start gap-3 px-5 py-3">
                <span
                  className={`mt-px w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium ${KIND[s.kind]?.[1] ?? "bg-tone-neutral text-tone-neutral-fg"}`}
                >
                  {KIND[s.kind]?.[0] ?? s.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-fg">{s.detail}</p>
                  {s.sample && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">“{s.sample}”</p>}
                  <p className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-fg-faint">
                    <span>{s.project}</span>
                    {s.title && <span>· {s.title}</span>}
                    <span title={new Date(s.at).toLocaleString()}>· {ago(s.at, now)}</span>
                    {s.conversation_id && (
                      <span>
                        ·{" "}
                        <Link
                          href={`/${gate}/conversations?id=${s.conversation_id}`}
                          className="text-link hover:underline"
                        >
                          Open the conversation
                        </Link>
                      </span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageFrame>
  );
}
