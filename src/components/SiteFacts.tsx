"use client";

// What Luke read on their website (lib/site-read, 0223), in Settings →
// General: each line in their site's own words, when it was read, and
// "Read it again" for a policy that changed. A line they would rather
// Luke forgot is struck where the rest of what he knows is.
//
// Callers: src/components/ProjectSettings.tsx.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
import { button, hint } from "@/components/ui/controls";

const TOPIC: Record<string, string> = {
  "what they sell": "What you sell",
  "policy: returns": "Returns",
  "policy: shipping": "Shipping",
  "policy: cash on delivery": "Cash on delivery",
  "policy: free shipping": "Free shipping",
};

export function SiteFacts({ projectId, readAt }: { projectId: string; readAt: string | null }) {
  const [lines, setLines] = useState<Array<{ note: string; topic: string | null }> | null>(null);
  const [when, setWhen] = useState(readAt);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("merchant_notes")
      .select("note, topic")
      .eq("project_id", projectId)
      .eq("source", "website")
      .order("created_at", { ascending: true });
    setLines((data as Array<{ note: string; topic: string | null }> | null) ?? []);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const again = async () => {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch("/api/site-read", { projectId });
    setBusy(false);
    if (!ok) return setError(String(data.error ?? "It couldn’t be read just now."));
    setWhen(new Date().toISOString());
    setNow(Date.now());
    await load();
  };

  return (
    <div>
      {lines === null ? (
        <div className="h-16 animate-pulse rounded bg-surface-hover" aria-busy />
      ) : lines.length ? (
        <ul className="divide-y divide-line rounded-card border border-line">
          {lines.map((l) => (
            <li key={l.note} className="px-3 py-2 text-[13px] text-fg">
              <span className="block text-[11px] font-medium text-fg-muted">
                {TOPIC[l.topic ?? ""] ?? l.topic ?? "From your website"}
              </span>
              {l.note}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-fg-muted">
          {when ? "Nothing about returns, delivery or what you sell was found there." : "Not read yet."}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={again} disabled={busy} className={button("secondary", "sm")}>
          <RefreshCw aria-hidden size={13} strokeWidth={2} className={busy ? "animate-spin" : ""} />
          {busy ? "Reading…" : "Read it again"}
        </button>
        {when && <span className="text-xs text-fg-faint">Read {ago(when, now)}</span>}
      </div>
      {error && (
        <p role="alert" className={`${hint} text-tone-critical-fg`}>
          {error}
        </p>
      )}
    </div>
  );
}
