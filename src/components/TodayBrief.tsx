"use client";

// The day's brief (lib/brief), first on the Overview: what needs the
// owner, what Luke noticed, what he built and what he is watching, in a
// few ranked lines. Nothing to say, nothing drawn: the calm line at the
// foot of the page already says so.
//
// Callers: src/components/AppShell.tsx (the Overview's brief).

import { useEffect, useState } from "react";
import { Sun } from "lucide-react";
import { briefOf, readBrief, type BriefInput, type BriefTone } from "@/lib/brief";
import { describeAlert, type Alert } from "@/lib/alerts";
import { supabase } from "@/lib/supabase-client";
import { Panel } from "@/components/Overview";

const DOT: Record<BriefTone, string> = {
  critical: "bg-signal-critical",
  attention: "bg-signal-attention",
  success: "bg-signal-success",
  info: "bg-signal-info",
};

export function TodayBrief({
  projectId,
  alerts,
  waiting,
}: {
  projectId: string;
  /** What Luke noticed, as the bell has it; null while it is read. */
  alerts: Alert[] | null;
  /** What waits for the owner's yes, as the bell counts it. */
  waiting: number;
}) {
  const [read, setRead] = useState<Pick<BriefInput, "builds" | "watching"> | null>(null);

  useEffect(() => {
    let live = true;
    readBrief(supabase, projectId).then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  if (!read || alerts === null) return null;
  const lines = briefOf({
    waiting,
    alerts: alerts.map((a) => ({ severity: a.severity, title: describeAlert(a).title })),
    ...read,
  });
  if (lines.length === 0) return null;
  return (
    <Panel title="Today" icon={<Sun aria-hidden size={14} strokeWidth={2} />}>
      <ul className="divide-y divide-line">
        {lines.map((l) => (
          <li key={l.text} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px] text-fg">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[l.tone]}`} />
            <span className="min-w-0">{l.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
