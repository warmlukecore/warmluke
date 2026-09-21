"use client";

// ─────────────────────────────────────────────────────────────
// ModuleSettings — rename a section, change its icon, move it under
// another, or delete it, without going through the assistant. Renaming
// a section shouldn't cost a model call.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { STORE_TABLES } from "@/lib/store-read";
import { ALLOWED_ICONS } from "@/lib/types";
import type { ModuleRow } from "@/lib/types";

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
  banknote: "💵",
  "map-pin": "📍",
  wallet: "👛",
  target: "🎯",
  "scan-line": "🔎",
  table: "📋",
};

interface Impact {
  records: number;
  children: Array<{ id: string; nav_label: string }>;
  blockedBy: string[];
}

export default function ModuleSettings({
  module,
  modules,
  projectId,
  onSaved,
  onDeleted,
  onClose,
}: {
  module: ModuleRow;
  modules: ModuleRow[];
  projectId: string;
  onSaved: (m: ModuleRow) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(module.nav_label);
  const [icon, setIcon] = useState(module.icon);
  const [parentId, setParentId] = useState<string>(module.parent_id ?? "");
  const [source, setSource] = useState<string>(module.source_table ?? "");
  const [confirm, setConfirm] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);

  // What deleting would take with it, fetched before the owner commits.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      fetch(`/api/modules?projectId=${projectId}&id=${module.id}`, {
        headers: data.session?.access_token
          ? { Authorization: `Bearer ${data.session.access_token}` }
          : {},
      })
        .then((r) => r.json())
        .then((j) => setImpact(j as Impact))
        .catch(() => setImpact(null));
    });
  }, [projectId, module.id]);

  const hasChildren = (impact?.children.length ?? 0) > 0;
  // Only top-level sections can be parents, and a section with children
  // can't itself be nested — that's the one-level rule.
  const parentOptions = modules.filter(
    (m) => m.id !== module.id && !m.parent_id && !hasChildren
  );
  const dirty =
    label.trim() !== module.nav_label ||
    icon !== module.icon ||
    (parentId || null) !== (module.parent_id ?? null) ||
    (source || null) !== (module.source_table ?? null);
  const canDelete = confirm.trim().toLowerCase() === module.nav_label.trim().toLowerCase();
  const blocked = (impact?.blockedBy.length ?? 0) > 0;

  async function save() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch(
      "/api/modules",
      {
        id: module.id,
        projectId,
        nav_label: label,
        icon,
        parent_id: parentId || null,
        source_table: source || null,
      },
      "PATCH"
    );
    setBusy(false);
    if (!ok || data.error) {
      setError((data.error as string) ?? "Couldn't save.");
      return;
    }
    onSaved(data.module as ModuleRow);
    onClose();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch(
      "/api/modules",
      { id: module.id, projectId, confirmName: confirm },
      "DELETE"
    );
    setBusy(false);
    if (!ok || data.error) {
      setError((data.error as string) ?? "Couldn't delete.");
      return;
    }
    onDeleted(module.id);
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
          <h2 className="font-display text-sm font-semibold text-white">Section settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && <ErrorNote error={asError(error)} dark />}

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Name
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
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
              disabled={hasChildren}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">Nothing — it sits at the top</option>
              {parentOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nav_label}
                </option>
              ))}
            </select>
            {hasChildren && (
              <div className="mt-1 text-[11px] text-slate-500">
                This section has {impact!.children.length} inside it, so it stays at the top.
                Sections nest one level only.
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Rows come from
            </label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Rows added in this section</option>
              {Object.entries(STORE_TABLES).map(([table, spec]) => (
                <option key={table} value={table}>
                  {spec.label}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {source
                ? // Said before they save, not after: switching replaces
                  // the columns, and rows they typed stop being shown.
                  "These rows come from Shopify and cannot be edited here — the import owns them. Rows added in this section stay in the database but are hidden while this is on, and the columns are replaced to match the store."
                : "This section holds rows you or your staff add."}
            </div>
          </div>

          <button
            onClick={save}
            disabled={busy || !dirty || !label.trim()}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>

          <div className="border-t border-slate-800 pt-4">
            {!confirmingDelete ? (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-xs font-medium text-rose-400 transition-colors hover:text-rose-300"
              >
                Delete this section
              </button>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
                  Removes <b>{module.nav_label}</b>
                  {impact ? `, its ${impact.records} row${impact.records === 1 ? "" : "s"}` : ""}
                  {hasChildren
                    ? ` and the ${impact!.children.length} section${
                        impact!.children.length === 1 ? "" : "s"
                      } inside it (${impact!.children.map((c) => c.nav_label).join(", ")})`
                    : ""}
                  . It cannot be undone.
                </div>
                {blocked && (
                  <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                    These rules write to this section and would stop working:{" "}
                    {impact!.blockedBy.join(", ")}. Turn them off in Rules first.
                  </div>
                )}
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type "${module.nav_label}" to confirm`}
                  className="w-full rounded-lg border border-rose-900 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-rose-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={remove}
                    disabled={busy || !canDelete || blocked}
                    className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
                  >
                    {busy ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingDelete(false);
                      setConfirm("");
                    }}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
