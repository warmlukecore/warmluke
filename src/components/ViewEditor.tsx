"use client";

// ─────────────────────────────────────────────────────────────
// Customize — how a section looks, changed by its owner without Luke
// (5 Oct): each column's name, whether it is on the table and where, the
// filters above it, and the order its rows open in. Free and at once: no
// model is asked. What it saves is the change Luke would have made
// (lib/view-edit), so it is checked the same way, kept as a version, and
// History puts it back.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Group } from "@/components/ui/Group";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { withComputed } from "@/lib/expr";
import { filterChoices, filterIsOff, viewEditPlans, type Sort } from "@/lib/view-edit";
import type { AssistantPlan, RecordRow, UiSchema } from "@/lib/types";
import { button, fieldOf, iconButton } from "@/components/ui/controls";

type Draft = { field: string; label: string; hidden: boolean };

export default function ViewEditor({
  sectionName,
  moduleId,
  schema,
  records,
  facets,
  onSave,
  onClose,
}: {
  sectionName: string;
  moduleId: string;
  schema: UiSchema;
  /** The rows loaded, for what a filter could offer. */
  records: RecordRow[];
  /** Over the store: what each filter can offer, from the whole list. */
  facets?: Record<string, string[]>;
  /** Saves the plans; resolves to the reasons, if any, it did not save. */
  onSave: (plans: AssistantPlan[]) => Promise<string[]>;
  onClose: () => void;
}) {
  const [cols, setCols] = useState<Draft[]>(() =>
    schema.columns.map((c) => ({ field: c.field, label: c.label, hidden: !!c.hidden }))
  );
  const [filters, setFilters] = useState<string[]>(() =>
    (schema.features?.filters ?? []).filter((f) => !filterIsOff(f)).map((f) => f.field)
  );
  const [sort, setSort] = useState<Sort | null>(schema.features?.defaultSort ?? null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);

  // What the rows hold, computed columns worked out as the table does.
  const valuesOf = useMemo(() => {
    const rows = schema.columns.some((c) => c.compute)
      ? records.map((r) => withComputed(schema.columns, r.data ?? {}))
      : records.map((r) => r.data ?? {});
    return (field: string) => [
      ...rows.flatMap((d) => {
        const v = d[field];
        return Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
      }),
      ...(facets?.[field] ?? []),
    ];
  }, [records, schema.columns, facets]);

  const outcome = viewEditPlans(
    moduleId,
    schema,
    { columns: cols.map((c) => ({ field: c.field, label: c.label, hidden: c.hidden })), filters, sort },
    valuesOf
  );
  const named = new Map(cols.map((c) => [c.field, c.label.trim() || c.field]));
  // A column a filter can list choices for, with them, or a number or an amount to narrow by its lowest and highest; no other is offered: a control nobody can use is not shown.
  const filterable = schema.columns.flatMap((c) => {
    const kept = schema.features?.filters?.find((f) => f.field === c.field)?.options;
    const choices = filterChoices(c, kept, valuesOf(c.field));
    return "options" in choices ? [{ field: c.field, options: choices.options, range: !!choices.range }] : [];
  });
  const problems = refused.length ? refused : outcome.errors;

  const move = (i: number, by: -1 | 1) =>
    setCols((cs) => {
      const j = i + by;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const set = (i: number, part: Partial<Draft>) => setCols((cs) => cs.map((c, k) => (k === i ? { ...c, ...part } : c)));

  const save = async () => {
    setBusy(true);
    setRefused([]);
    try {
      const why = await onSave(outcome.plans);
      if (why.length) setRefused(why);
      else onClose();
    } catch (e) {
      setRefused([asError(e, "That didn't save.").what]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Customize ${sectionName}`}
      description="How this section looks, for everyone who sees it. Saved at once; History keeps the version before."
      onClose={onClose}
      tall
      footer={
        <>
          <button onClick={onClose} className={button("secondary")}>
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || outcome.plans.length === 0 || outcome.errors.length > 0}
            className={button("primary")}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problems.length > 0 && (
          <ErrorNote
            error={asError(problems.join(" "), "That can't be saved.")}
            compact
            onDismiss={refused.length ? () => setRefused([]) : undefined}
          />
        )}

        <Group
          title="Columns"
          description="Rename one, take it off the table (it is still there when a row is opened), or move it."
        >
          <ul className="-my-2 divide-y divide-line">
            {cols.map((c, i) => {
              const was = schema.columns.find((o) => o.field === c.field)!;
              return (
                <li key={c.field} className="flex items-center gap-2 py-2">
                  <div className="flex shrink-0 flex-col">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${was.label} up`}
                      className={`${iconButton} h-6 disabled:opacity-30`}
                    >
                      <ArrowUp aria-hidden size={14} strokeWidth={1.75} />
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === cols.length - 1}
                      aria-label={`Move ${was.label} down`}
                      className={`${iconButton} h-6 disabled:opacity-30`}
                    >
                      <ArrowDown aria-hidden size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  <input
                    value={c.label}
                    onChange={(e) => set(i, { label: e.target.value })}
                    aria-label={`Name of ${was.label}`}
                    maxLength={60}
                    className={`${fieldOf("sm")} min-w-0 flex-1`}
                  />
                  {/* An eye: open while it is on the table, struck through while it is not, and the word then. */}
                  {c.hidden && <span className="shrink-0 text-xs text-fg-muted">Hidden</span>}
                  <button
                    type="button"
                    onClick={() => set(i, { hidden: !c.hidden })}
                    aria-pressed={!c.hidden}
                    aria-label={`Show ${was.label} on the table`}
                    title={c.hidden ? "Hidden from the table: show it" : "On the table: hide it"}
                    className={iconButton}
                  >
                    {c.hidden ? (
                      <EyeOff aria-hidden size={16} strokeWidth={1.75} />
                    ) : (
                      <Eye aria-hidden size={16} strokeWidth={1.75} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Group>

        {filterable.length > 0 && (
          <Group
            title="Filters"
            description="The choices above the table, from what its rows hold; a number or an amount by its lowest and highest."
          >
            <ul className="-my-2 divide-y divide-line">
              {filterable.map((f) => {
                const on = filters.includes(f.field);
                return (
                  <li key={f.field} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-fg">{named.get(f.field)}</div>
                      <div className="truncate text-xs text-fg-muted">
                        {f.range ? "Min and max, either left open" : f.options.join(", ")}
                      </div>
                    </div>
                    <span className="w-6 shrink-0 text-right text-xs text-fg-muted">{on ? "On" : "Off"}</span>
                    <Switch
                      checked={on}
                      onChange={(next) =>
                        setFilters((fs) => (next ? [...fs, f.field] : fs.filter((x) => x !== f.field)))
                      }
                      label={`Filter by ${named.get(f.field)}`}
                    />
                  </li>
                );
              })}
            </ul>
          </Group>
        )}

        <Group title="Order" description="The order rows open in. Tapping a column's head still sorts it for you.">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              value={sort?.field ?? ""}
              options={cols.map((c) => ({ value: c.field, label: named.get(c.field)! }))}
              onChange={(field) => setSort(field ? { field, dir: sort?.dir ?? "asc" } : null)}
              label="Order rows by"
              empty="As they came in"
            />
            {sort && (
              <Select
                value={sort.dir}
                options={[
                  { value: "asc", label: "Lowest or earliest first" },
                  { value: "desc", label: "Highest or latest first" },
                ]}
                onChange={(dir) => setSort({ field: sort.field, dir: dir === "desc" ? "desc" : "asc" })}
                label="Which first"
                clearable={false}
              />
            )}
          </div>
        </Group>
      </div>
    </Dialog>
  );
}
