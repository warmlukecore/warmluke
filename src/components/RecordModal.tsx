"use client";

// ─────────────────────────────────────────────────────────────
// RecordModal — the owner's own way in and out of their data.
// The form is built from the module's columns, so it fits whatever
// the assistant generated without knowing anything about it.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useLinkOptions } from "@/components/LinkContext";
import type { FeatureSchema, RecordRow, SchemaColumn, UiSchema } from "@/lib/types";

export type RecordDraft = Record<string, unknown>;

/**
 * Choices for a badge/dropdown field: whatever the assistant configured
 * as a filter, plus every value already in use. Derived, so a field
 * nobody configured still offers the values the owner actually types.
 */
function optionsFor(
  field: string,
  features: FeatureSchema | null,
  records: RecordRow[]
): string[] {
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
  const base =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
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
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
          on
            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
            : "border-slate-200 text-slate-500 hover:bg-slate-50"
        }`}
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
            on ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"
          }`}
        >
          {on ? "✓" : ""}
        </span>
        {on ? "Yes" : "No"}
      </button>
    );
  }

  if (col.type === "longtext") {
    return (
      <textarea
        value={str}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={`${base} resize-y`}
      />
    );
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
  const columns = schema.columns ?? [];
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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[85vh] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="font-display text-sm font-semibold text-slate-800">
            {isNew ? "Add a row" : "Edit row"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[60dvh] space-y-3 overflow-y-auto px-5 py-4 thin-scroll">
          {columns.map((col) => (
            <div key={col.field}>
              <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                {col.label}
              </label>
              <Field
                col={col}
                value={draft[col.field]}
                options={optionMap[col.field] ?? []}
                onChange={(v) => setDraft((prev) => ({ ...prev, [col.field]: v }))}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          {!isNew &&
            (confirmingDelete ? (
              <button
                onClick={onDelete}
                disabled={busy}
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Really delete"}
              </button>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
                className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50"
              >
                Delete
              </button>
            ))}
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : isNew ? "Add row" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
