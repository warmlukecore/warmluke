"use client";

// ─────────────────────────────────────────────────────────────
// AutomationsPanel — rules run invisibly in the database, which is
// exactly why the owner needs somewhere to see what exists, whether
// it actually ran, and how to switch it off.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { describeAutomation } from "@/lib/describe";
import { engineError, fixPrompt, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { AutomationRow, AutomationRunRow, ModuleRow } from "@/lib/types";

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
        .in("automation_id", list.map((r) => r.id))
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
    const { error: e } = await supabase
      .from("automations")
      .update({ enabled: !rule.enabled })
      .eq("id", rule.id);
    if (e) setError(e.message);
    else await load();
    setBusyId(null);
  }

  const moduleName = (id: string | null) =>
    modules.find((m) => m.id === id)?.nav_label ?? "—";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-800">Rules</h2>
            <p className="text-[11px] text-slate-400">
              These run by themselves on every change — from this app or anywhere else.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 thin-scroll">
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          {loading && <div className="text-sm text-slate-400">Loading…</div>}

          {!loading && rules.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center">
              <div className="text-sm text-slate-500">No rules yet.</div>
              <p className="mx-auto mt-1.5 max-w-xs text-[11px] leading-relaxed text-slate-400">
                Ask Luke for something like &ldquo;when a job is marked done, take
                the parts off my stock&rdquo;.
              </p>
            </div>
          )}

          {rules.map((rule) => {
            const run = runs[rule.id];
            return (
              <div
                key={rule.id}
                className={`rounded-xl border px-3.5 py-3 transition-colors ${
                  rule.enabled ? "border-slate-200 bg-white" : "border-slate-150 bg-slate-50 opacity-70"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800">{rule.name}</div>
                    <div className="text-[11px] text-slate-400">
                      on {moduleName(rule.module_id)}
                    </div>
                  </div>
                  <button
                    onClick={() => toggle(rule)}
                    disabled={busyId === rule.id}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase transition-colors disabled:opacity-40 ${
                      rule.enabled
                        ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                        : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                    }`}
                  >
                    {busyId === rule.id ? "…" : rule.enabled ? "On" : "Off"}
                  </button>
                </div>

                <ul className="mt-2 space-y-0.5 border-t border-slate-100 pt-2">
                  {describeAutomation({ name: rule.name, definition: rule.definition }, modules).map(
                    (line, i) => (
                      <li key={i} className="text-[11px] leading-relaxed text-slate-600">
                        {line}
                      </li>
                    )
                  )}
                </ul>

                <div className="mt-2 text-[10px] text-slate-400">
                  {run ? (
                    <>
                      {run.ok ? "✓ Last ran" : "⚠ Last attempt failed"}{" "}
                      {new Date(run.at).toLocaleString()}
                      {run.detail && typeof run.detail.rows === "number" && (
                        <> · {run.detail.rows} row(s) changed</>
                      )}
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
      </div>
    </div>
  );
}
