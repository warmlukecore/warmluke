"use client";

// ─────────────────────────────────────────────────────────────
// AutomationsPanel — rules run invisibly in the database, which is
// exactly why the owner needs somewhere to see what exists, whether
// it actually ran, and how to switch it off.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { describeAutomation } from "@/lib/describe";
import { asError, engineError, fixPrompt, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { AutomationRow, AutomationRunRow, ModuleRow } from "@/lib/types";
import { Check, TriangleAlert, Zap } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";

type RunSummary = { ok: boolean; at: string; detail: Record<string, unknown> | null };

export default function AutomationsPanel({
  projectId,
  modules,
  onClose,
  onFix,
}: {
  projectId: string;
  modules: ModuleRow[];
  /** Hands a rule that stopped to Luke. Absent, the failure is only shown. */
  onFix?: (action: FixAction) => void | Promise<void>;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<AutomationRow[]>([]);
  const [runs, setRuns] = useState<Record<string, RunSummary>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("automations")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (e) {
      setError(e.message);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as AutomationRow[];
    setRules(list);

    if (list.length > 0) {
      const { data: runRows } = await supabase
        .from("automation_runs")
        .select("*")
        .in(
          "automation_id",
          list.map((r) => r.id)
        )
        .order("created_at", { ascending: false })
        .limit(200);
      const latest: Record<string, RunSummary> = {};
      for (const r of (runRows ?? []) as AutomationRunRow[]) {
        // Ordered newest first, so the first one seen per rule is its last run.
        if (!latest[r.automation_id]) {
          latest[r.automation_id] = { ok: r.ok, at: r.created_at, detail: r.detail };
        }
      }
      setRuns(latest);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(rule: AutomationRow) {
    setBusyId(rule.id);
    setError(null);
    const { error: e } = await supabase.from("automations").update({ enabled: !rule.enabled }).eq("id", rule.id);
    if (e) setError(e.message);
    else await load();
    setBusyId(null);
  }

  const moduleName = (id: string | null) => modules.find((m) => m.id === id)?.nav_label ?? "—";

  return (
    <Dialog
      tall
      title="Rules"
      description="These run by themselves on every change — from this app or anywhere else."
      onClose={onClose}
    >
      <div className="space-y-3">
        {error && <ErrorNote error={asError(error)} />}

        {loading && (
          <div className="space-y-3" aria-busy>
            {[0, 1].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-card bg-surface-hover" />
            ))}
          </div>
        )}

        {!loading && rules.length === 0 && (
          <div className="flex flex-col items-center rounded-card border border-dashed border-line-strong px-4 py-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-fg-muted">
              <Zap aria-hidden size={18} strokeWidth={1.75} />
            </span>
            <div className="mt-3 text-[13px] font-medium text-fg">No rules yet</div>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-fg-muted">
              Ask Luke for something like &ldquo;when a job is marked done, take the parts off my stock&rdquo;.
            </p>
          </div>
        )}

        {rules.map((rule) => {
          const run = runs[rule.id];
          return (
            <div
              key={rule.id}
              className={`rounded-card border border-line px-4 py-3 transition-opacity ${rule.enabled ? "" : "bg-surface-subdued opacity-75"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-fg">{rule.name}</div>
                  <div className="text-xs text-fg-muted">on {moduleName(rule.module_id)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-fg-muted">
                    {busyId === rule.id ? "…" : rule.enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={rule.enabled}
                    onChange={() => toggle(rule)}
                    disabled={busyId === rule.id}
                    label={`${rule.name} is ${rule.enabled ? "on" : "off"}`}
                  />
                </div>
              </div>

              <ul className="mt-2 space-y-0.5 border-t border-line pt-2">
                {describeAutomation({ name: rule.name, definition: rule.definition }, modules).map((line, i) => (
                  <li key={i} className="text-xs leading-relaxed text-fg-muted">
                    {line}
                  </li>
                ))}
              </ul>

              <div className="mt-2 text-[11px] text-fg-faint">
                {run ? (
                  <>
                    {run.ok ? (
                      <>
                        <Check
                          aria-hidden
                          size={12}
                          strokeWidth={2.25}
                          className="mr-1 inline align-[-1px] text-signal-success"
                        />
                        Last ran
                      </>
                    ) : (
                      <>
                        <TriangleAlert
                          aria-hidden
                          size={12}
                          strokeWidth={2}
                          className="mr-1 inline align-[-1px] text-signal-attention"
                        />
                        Last attempt failed
                      </>
                    )}{" "}
                    {new Date(run.at).toLocaleString()}
                    {run.detail && typeof run.detail.rows === "number" && <> · {run.detail.rows} row(s) changed</>}
                  </>
                ) : (
                  "Hasn't run yet"
                )}
              </div>
              {/* A rule that stopped is a design that no longer fits
                  its rows — a field renamed under it, most often. The
                  correction is a rule of the same name, which
                  replaces this one in place and keeps its history,
                  and it waits for a yes like anything else Luke
                  proposes. */}
              {run && !run.ok && typeof run.detail?.error === "string" && (
                <div className="mt-1.5">
                  <ErrorNote
                    compact
                    onFix={onFix}
                    error={engineError(
                      `“${rule.name}” stopped on its last run.`,
                      [run.detail.error],
                      fixPrompt({
                        what: `the rule “${rule.name}”`,
                        tried: rule.definition,
                        errors: [run.detail.error],
                        ask: `Correct this rule so it does the same job. Use the same name, “${rule.name}”, so it replaces the rule in place.`,
                      }),
                      "No rows were changed by it."
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
