"use client";

// ─────────────────────────────────────────────────────────────
// NewSection — build a section by hand: name it, pick an icon, choose
// what it sits inside, and list its fields. The assistant is the fast
// path, not the only one; adding a section under an existing one is a
// structural decision the owner may just want to make themselves.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { apiFetch } from "@/lib/auth";
import { ALLOWED_ICONS, COLUMN_TYPES } from "@/lib/types";
import { COLUMNS } from "@/lib/capabilities";
import type { ColumnType, ModuleRow } from "@/lib/types";

const ICON_GLYPHS: Record<string, string> = {
  "shopping-cart": "🛒",
  package: "📦",
  users: "👥",
  receipt: "🧾",
  calendar: "📅",
  "clipboard-list": "📋",
  "undo-2": "↩️",
  box: "📦",
  heart: "❤️",
  wrench: "🔧",
  globe: "🌐",
  truck: "🚚",
  wallet: "👛",
  target: "🎯",
  "scan-line": "🔎",
  table: "📋",
};

interface Draft {
  label: string;
  type: ColumnType;
}

export default function NewSection({
  projectId,
  modules,
  /** Pre-selected parent when opened from a section's "+" button. */
  initialParentId,
  onCreated,
  onClose,
}: {
  projectId: string;
  modules: ModuleRow[];
  initialParentId?: string | null;
  onCreated: (m: ModuleRow) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState("table");
  const [parentId, setParentId] = useState(initialParentId ?? "");
  const [fields, setFields] = useState<Draft[]>([{ label: "Name", type: "text" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parents = modules.filter((m) => !m.parent_id);

  function setField(i: number, patch: Partial<Draft>) {
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  async function create() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch("/api/modules", {
      projectId,
      nav_label: label,
      icon,
      parent_id: parentId || null,
      fields: fields.filter((f) => f.label.trim()),
    });
    setBusy(false);
    if (!ok || data.error) {
      setError((data.error as string) ?? "Couldn't create it.");
      return;
    }
    onCreated(data.module as ModuleRow);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-slate-800 bg-slate-900 text-slate-200 shadow-2xl thin-scroll-dark sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="font-display text-sm font-semibold text-white">
            {initialParentId ? "New section inside" : "New section"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <div className="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Name
            </label>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Repairs, Invoices, Suppliers…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Icon
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ALLOWED_ICONS.map((name) => (
                <button
                  key={name}
                  onClick={() => setIcon(name)}
                  title={name}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border text-base transition-colors ${
                    icon === name
                      ? "border-blue-500 bg-blue-500/20"
                      : "border-slate-700 hover:bg-slate-800"
                  }`}
                >
                  {ICON_GLYPHS[name] ?? "📋"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Sits inside
            </label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Nothing — it sits at the top</option>
              {parents.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nav_label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">
                Fields
              </label>
              <span className="text-[10px] text-slate-500">
                you can ask the assistant for more later
              </span>
            </div>
            <div className="space-y-1.5">
              {fields.map((f, i) => (
                <div key={i} className="flex gap-1.5">
                  <input
                    value={f.label}
                    onChange={(e) => setField(i, { label: e.target.value })}
                    placeholder="Field name"
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm outline-none focus:border-blue-500"
                  />
                  <select
                    value={f.type}
                    onChange={(e) => setField(i, { type: e.target.value as ColumnType })}
                    title={COLUMNS[f.type]}
                    className="w-32 shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  >
                    {COLUMN_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}
                    disabled={fields.length === 1}
                    aria-label="Remove field"
                    className="shrink-0 rounded-lg px-2 text-slate-500 transition-colors hover:bg-slate-800 hover:text-rose-400 disabled:opacity-30"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setFields((prev) => [...prev, { label: "", type: "text" }])}
              className="mt-1.5 text-xs font-medium text-blue-400 transition-colors hover:text-blue-300"
            >
              + Add a field
            </button>
          </div>

          <button
            onClick={create}
            disabled={busy || !label.trim()}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create section"}
          </button>
        </div>
      </div>
    </div>
  );
}
