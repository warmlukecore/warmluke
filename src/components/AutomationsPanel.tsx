"use client";

// ─────────────────────────────────────────────────────────────
// AutomationsPanel — rules run invisibly in the database, which is
// exactly why the owner needs somewhere to see what exists, whether
// it actually ran, and how to switch it off.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { describeAutomation } from "@/lib/describe";
import { useFormat } from "@/lib/format";
import { asError, engineError, fixPrompt, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { AutomationRow, ModuleRow } from "@/lib/types";
import { Check, TriangleAlert, Zap } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { Select } from "@/components/ui/Select";
import { readsSection } from "@/lib/section-ref";

/** What a rule has done (abo_rule_log, 0172): its runs of either kind, counted in the database. */
type RunSummary = { runs: number; failed: number; last: { at: string; ok: boolean; error: string | null } | null };

export default function AutomationsPanel({
  projectId,
  modules,
  sectionId = null,
  onClose,
  onFix,
}: {
  projectId: string;
  modules: ModuleRow[];
  /** The section open behind the dialog: its rules first, all of them a pick away (Tanish, 4 Oct). */
  sectionId?: string | null;
  /** Hands a rule that stopped to Luke. Absent, the failure is only shown. */
  onFix?: (action: FixAction) => void | Promise<void>;
  onClose: () => void;
}) {
  const fmt = useFormat();
  const [rules, setRules] = useState<AutomationRow[]>([]);
  const [runs, setRuns] = useState<Record<string, RunSummary>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"section" | "all">(sectionId ? "section" : "all");
  const section = sectionId ? (modules.find((m) => m.id === sectionId) ?? null) : null;
  // A section's rules: those on it, and those that read it from elsewhere.
  const onSection = (rule: AutomationRow) =>
    !!section &&
    (rule.module_id === section.id || readsSection(rule.definition, { id: section.id, name: section.name }));
  const shown = scope === "section" && section ? rules.filter(onSection) : rules;

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
      // A rule of code keeps its runs apart from the rest, and one busy
      // rule's thousands of rows hid every other rule's newest 200: so
      // each rule's own count, of both kinds, from the database.
      const { data: log } = await supabase.rpc("abo_rule_log", { p_project: projectId });
      setRuns((log ?? {}) as Record<string, RunSummary>);
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

        {!loading && section && rules.length > 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">Showing</span>
            <div className="w-56">
              <Select
                label="Which rules"
                clearable={false}
                value={scope}
                onChange={(v) => setScope(v === "all" ? "all" : "section")}
                options={[
                  { value: "section", label: `${section.nav_label} (${rules.filter(onSection).length})` },
                  { value: "all", label: `All sections (${rules.length})` },
                ]}
              />
            </div>
          </div>
        )}
        {!loading && section && scope === "section" && rules.length > 0 && shown.length === 0 && (
          <p className="rounded-card border border-dashed border-line-strong px-4 py-6 text-center text-xs text-fg-muted">
            No rule works on {section.nav_label}. {rules.length} {rules.length === 1 ? "works" : "work"} on other
            sections: pick All sections to see {rules.length === 1 ? "it" : "them"}.
          </p>
        )}

        {shown.map((rule) => {
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
                {run?.last ? (
                  <>
                    {run.last.ok ? (
                      <Check
                        aria-hidden
                        size={12}
                        strokeWidth={2.25}
                        className="mr-1 inline align-[-1px] text-signal-success"
                      />
                    ) : (
                      <TriangleAlert
                        aria-hidden
                        size={12}
                        strokeWidth={2}
                        className="mr-1 inline align-[-1px] text-signal-attention"
                      />
                    )}
                    Ran {run.runs.toLocaleString()} {run.runs === 1 ? "time" : "times"} · last{" "}
                    {new Date(run.last.at).toLocaleString(fmt.locale, {
                      day: "numeric",
                      month: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    · {run.failed === 0 ? "no errors" : `${run.failed.toLocaleString()} failed`}
                    {!run.last.ok && " · the last one failed"}
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
              {run?.last && !run.last.ok && run.last.error && (
                <div className="mt-1.5">
                  <ErrorNote
                    compact
                    onFix={onFix}
                    error={engineError(
                      `“${rule.name}” stopped on its last run.`,
                      [run.last.error],
                      fixPrompt({
                        what: `the rule “${rule.name}”`,
                        tried: rule.definition,
                        errors: [run.last.error],
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
