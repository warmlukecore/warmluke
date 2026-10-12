"use client";

// ─────────────────────────────────────────────────────────────
// Yesterday, on the console's first screen (0211): how many things went
// wrong, the day before for the trend, by kind, and the conversations
// that went worst, each a link to the turn. The radar keeps the signs
// (abo_trouble_scan); this only reads them, in the viewer's own day.
//
// Says nothing at all on a database without 0211, so the accounts list
// it sits above never breaks for it.
//
// Callers: src/app/[gate]/page.tsx.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { scopeArgs, scopeQuery, useConsoleScope } from "@/lib/console-scope";
import { troubleHref, troubleName, troubleTone } from "@/lib/trouble";
import { card } from "@/components/ui/controls";

type Day = {
  day: string;
  total: number;
  before: number;
  kinds: Array<{ kind: string; n: number }>;
  worst: Array<{
    score: number;
    n: number;
    project: string;
    title: string | null;
    conversation_id: string | null;
    kinds: string[];
    sample: string | null;
  }>;
};

export function TroubleDay() {
  const scope = useConsoleScope();
  const gate = useParams<{ gate: string }>().gate;
  const [day, setDay] = useState<Day | null>(null);

  useEffect(() => {
    let live = true;
    supabase
      .rpc("abo_admin_trouble_day", {
        ...scopeArgs(scope),
        p_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      .then(({ data, error }) => {
        if (live) setDay(error ? null : ((data as Day | null) ?? null));
      });
    return () => {
      live = false;
    };
  }, [scope]);

  if (!day) return null;
  const all = `/${gate}/trouble${scopeQuery(scope)}`;
  return (
    <section aria-label="Yesterday" className={`${card} mt-6 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold text-fg">
          {day.total === 0
            ? "Nothing went wrong yesterday"
            : `${day.total} ${day.total === 1 ? "thing" : "things"} went wrong yesterday`}
          <span className="ml-2 font-normal text-fg-muted">{day.before} the day before</span>
        </h2>
        <Link href={all} className="text-xs text-link hover:underline">
          See all in Needs a look
        </Link>
      </div>
      {day.kinds.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {day.kinds.map((k) => (
            <li key={k.kind} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${troubleTone(k.kind)}`}>
              {troubleName(k.kind)} {k.n}
            </li>
          ))}
        </ul>
      )}
      {day.worst.length > 0 && (
        <ol className="mt-3 divide-y divide-line border-t border-line">
          {day.worst.slice(0, 3).map((w, i) => (
            <li key={`${w.conversation_id ?? w.project}-${i}`} className="flex items-start gap-3 py-2.5 last:pb-0">
              <span className="mt-px w-5 shrink-0 text-right text-xs tabular-nums text-fg-faint">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">
                  {w.title ?? w.project}
                  {w.title && <span className="text-fg-muted"> · {w.project}</span>}
                </p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {w.n} {w.n === 1 ? "sign" : "signs"}: {w.kinds.map(troubleName).join(", ")}
                </p>
                {w.sample && <p className="mt-0.5 line-clamp-1 text-xs text-fg-faint">“{w.sample}”</p>}
              </div>
              {w.conversation_id && (
                <Link
                  href={troubleHref(gate, w.conversation_id)}
                  className="shrink-0 text-xs text-link hover:underline"
                >
                  Open
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
