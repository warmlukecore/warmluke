"use client";

// ─────────────────────────────────────────────────────────────
// RecordModal — the owner's own way in and out of their data.
// The form is built from the module's columns, so it fits whatever
// the assistant generated without knowing anything about it.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useLinkOptions } from "@/components/LinkContext";
import type { FeatureSchema, RecordRow, SchemaColumn, UiSchema } from "@/lib/types";
import { Check } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { button, field, label } from "@/components/ui/controls";

export type RecordDraft = Record<string, unknown>;

/**
 * Choices for a badge/dropdown field: whatever the assistant configured
 * as a filter, plus every value already in use. Derived, so a field
 * nobody configured still offers the values the owner actually types.
 */
function optionsFor(field: string, features: FeatureSchema | null, records: RecordRow[]): string[] {
  const configured = features?.filters?.find((f) => f.field === field)?.options ?? [];
  const seen = new Set<string>(configured);
  for (const r of records) {
    const v = r.data?.[field];
    if (typeof v === "string" && v.trim()) seen.add(v.trim());
  }
  return [...seen];
}

function Field({
  col,
  value,
  options,
  onChange,
}: {
  col: SchemaColumn;
  value: unknown;
  options: string[];
  onChange: (v: string) => void;
}) {
  const linkOptions = useLinkOptions();
  const base = field;
  const str = value === null || value === undefined ? "" : String(value);

  // A link is chosen from the target section's rows, never typed: that
  // is the whole point of it not being a copied string.
  if (col.type === "link") {
    const rows = (col.linkTo && linkOptions[col.linkTo]) || [];
    return (
      <select value={str} onChange={(e) => onChange(e.target.value)} className={base}>
        <option value="">—</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
        {str && !rows.some((r) => r.id === str) && <option value={str}>(deleted)</option>}
      </select>
    );
  }

  if (col.type === "boolean") {
    const on = value === true || str === "true" || str === "yes" || value === 1;
    return (
      <button
        type="button"
        onClick={() => onChange(on ? "false" : "true")}
        aria-pressed={on}
        className={`flex w-full items-center gap-2 rounded-control border px-3 py-1.5 text-[13px] leading-5 transition-colors ${
          on
            ? "border-tone-success bg-tone-success/30 text-tone-success-fg"
            : "border-line-strong text-fg-muted hover:bg-surface-hover"
        }`}
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border ${
            on ? "border-signal-success bg-signal-success text-white" : "border-line-strong"
          }`}
        >
          {on ? <Check aria-hidden size={12} strokeWidth={2.5} /> : null}
        </span>
        {on ? "Yes" : "No"}
      </button>
    );
  }

  if (col.type === "longtext") {
    return <textarea value={str} onChange={(e) => onChange(e.target.value)} rows={3} className={`${base} resize-y`} />;
  }

  if ((col.type === "badge" || col.type === "dropdown") && options.length > 0) {
    return (
      <select value={str} onChange={(e) => onChange(e.target.value)} className={base}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {str && !options.includes(str) && <option value={str}>{str}</option>}
      </select>
    );
  }

  // Native input types give phones the right keyboard and picker.
  const inputType =
    col.type === "number" || col.type === "currency" || col.type === "percent"
      ? "number"
      : col.type === "date"
        ? "date"
        : col.type === "time"
          ? "time"
          : col.type === "phone"
            ? "tel"
            : col.type === "email"
              ? "email"
              : col.type === "url"
                ? "url"
                : "text";

  const placeholder =
    col.type === "barcode"
      ? "Scan or type a code"
      : col.type === "url"
        ? "https://…"
        : col.type === "percent"
          ? "15 for 15%"
          : "";

  return (
    <input
      type={inputType}
      value={str}
      onChange={(e) => onChange(e.target.value)}
      step={col.type === "currency" ? "0.01" : undefined}
      placeholder={placeholder}
      className={base}
    />
  );
}

export default function RecordModal({
  schema,
  records,
  record,
  busy,
  onSave,
  onDelete,
  onClose,
}: {
  schema: UiSchema;
  records: RecordRow[];
  /** null = creating a new row. */
  record: RecordRow | null;
  busy: boolean;
  onSave: (data: RecordDraft) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onClose: () => void;
}) {
  // A computed column has no value of its own to edit — it is worked
  // out from the others every time the row is read. Leaving it out here
  // is also what keeps it out of the draft, so nothing ever writes one.
  const columns = (schema.columns ?? []).filter((c) => !c.compute);
  const features = (schema as UiSchema & { features?: FeatureSchema | null }).features ?? null;
  const isNew = record === null;

  const [draft, setDraft] = useState<RecordDraft>(() => {
    const start: RecordDraft = {};
    for (const c of columns) start[c.field] = record?.data?.[c.field] ?? "";
    return start;
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const optionMap = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of columns) {
      if (c.type === "badge" || c.type === "dropdown") {
        m[c.field] = optionsFor(c.field, features, records);
      }
    }
    return m;
  }, [columns, features, records]);

  return (
    <Dialog
      title={isNew ? "Add a row" : "Edit row"}
      onClose={onClose}
      footer={
        <>
          {!isNew &&
            (confirmingDelete ? (
              <button onClick={onDelete} disabled={busy} className={button("critical")}>
                {busy ? "Deleting…" : "Really delete"}
              </button>
            ) : (
              <button onClick={() => setConfirmingDelete(true)} disabled={busy} className={button("critical-plain")}>
                Delete
              </button>
            ))}
          <button onClick={onClose} disabled={busy} className={`${button("plain")} ml-auto`}>
            Cancel
          </button>
          <button onClick={() => onSave(draft)} disabled={busy} className={button("primary")}>
            {busy ? "Saving…" : isNew ? "Add row" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {columns.map((col) => (
          <div key={col.field}>
            <label className={label}>{col.label}</label>
            <Field
              col={col}
              value={draft[col.field]}
              options={optionMap[col.field] ?? []}
              onChange={(v) => setDraft((prev) => ({ ...prev, [col.field]: v }))}
            />
          </div>
        ))}
      </div>
    </Dialog>
  );
}
