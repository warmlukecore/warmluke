"use client";

// ─────────────────────────────────────────────────────────────
// Who does what, and how long a restock takes (lib/team-facts, 0222):
// the same short form in onboarding ("Your team", skippable) and in
// Settings → General. Every answer is optional and kept as a line of
// what Luke knows; answered again, it replaces what was said before.
//
// Callers: src/app/onboarding/page.tsx, src/components/ProjectSettings.tsx.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { TEAM_QUESTIONS, loadTeam, saveTeam, skipTeam, teamProblems, type TeamAnswers } from "@/lib/team-facts";
import { button, field, hint, label, note } from "@/components/ui/controls";

export function TeamFacts({
  projectId,
  submitLabel = "Save",
  onDone,
  skippable = false,
}: {
  projectId: string;
  submitLabel?: string;
  /** Saved or skipped. */
  onDone?: () => void;
  /** Onboarding's: "Skip for now" beside the button. */
  skippable?: boolean;
}) {
  const [a, setA] = useState<TeamAnswers | null>(null);
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    loadTeam(supabase, projectId).then((x) => live && setA(x));
    return () => {
      live = false;
    };
  }, [projectId]);

  if (!a) return <div className="h-64 animate-pulse rounded-card bg-surface-hover" aria-busy />;
  const wrong = teamProblems(a);
  const set = (k: keyof TeamAnswers, v: string) => {
    setSaved(false);
    setA({ ...a, [k]: v });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!a || Object.keys(wrong).length > 0) return;
    setBusy("save");
    setError(null);
    const failed = await saveTeam(supabase, projectId, a);
    setBusy(null);
    if (failed) setError("That did not save. Try again.");
    else {
      setSaved(true);
      onDone?.();
    }
  }

  async function skip() {
    setBusy("skip");
    setError(null);
    const failed = await skipTeam(supabase, projectId);
    setBusy(null);
    if (failed) setError("That did not go through. Try again.");
    else onDone?.();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {TEAM_QUESTIONS.map((q) => (
        <div key={q.key}>
          <label htmlFor={`team-${q.key}`} className={label}>
            {q.label}
          </label>
          <input
            id={`team-${q.key}`}
            value={a[q.key]}
            onChange={(e) => set(q.key, e.target.value)}
            placeholder={q.hint}
            maxLength={120}
            autoComplete="off"
            aria-invalid={!!wrong[q.key]}
            className={field}
          />
          {wrong[q.key] && <p className="mt-1.5 text-xs text-tone-critical-fg">{wrong[q.key]}</p>}
        </div>
      ))}
      <div>
        <label htmlFor="team-restock" className={label}>
          How many days does a restock usually take to arrive?
        </label>
        <input
          id="team-restock"
          inputMode="numeric"
          value={a.restock_days}
          onChange={(e) => set("restock_days", e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
          placeholder="e.g. 10"
          autoComplete="off"
          aria-invalid={!!wrong.restock_days}
          aria-describedby="team-restock-hint"
          className={`${field} max-w-32`}
        />
        <p id="team-restock-hint" className={hint}>
          Running low warns you in time for a restock to arrive.
        </p>
        {wrong.restock_days && <p className="mt-1.5 text-xs text-tone-critical-fg">{wrong.restock_days}</p>}
      </div>
      {error && <div className={note.critical}>{error}</div>}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button type="submit" disabled={busy !== null || Object.keys(wrong).length > 0} className={button("primary")}>
          {busy === "save" ? "Saving…" : submitLabel}
        </button>
        {skippable && (
          <button type="button" onClick={skip} disabled={busy !== null} className={button("plain")}>
            {busy === "skip" ? "Skipping…" : "Skip for now"}
          </button>
        )}
        {!skippable && saved && <span className="text-xs text-fg-muted">Saved. Luke knows this now.</span>}
      </div>
    </form>
  );
}
