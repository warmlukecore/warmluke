"use client";

// ─────────────────────────────────────────────────────────────
// VersionHistory — append-only audit of ui_schemas.
// Rollback NEVER deletes: it copies an old version forward as
// a brand-new version row.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import type { UiSchemaRow } from "@/lib/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function VersionHistory({
  versions,
  onRollback,
  onClose,
}: {
  versions: UiSchemaRow[];
  onRollback: (moduleId: string) => void;
  onClose: () => void;
}) {
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = versions[0]; // passed in descending order

  async function rollback(row: UiSchemaRow) {
    setBusyVersion(row.version);
    setError(null);
    try {
      const res = await fetch("/api/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ moduleId: row.module_id, version: row.version }),
      });
      const data = await res.json();
      if (!res.ok || !data.applied) {
        setError(data.error ?? "Rollback failed.");
        return;
      }
      onRollback(row.module_id);
      onClose();
    } catch {
      setError("Rollback failed — could not reach the server.");
    } finally {
      setBusyVersion(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6">
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Schema version history</h2>
            <p className="text-[11px] text-slate-400">
              Nothing is ever deleted — rollback adds a new version.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 thin-scroll">
          {error && (
            <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}
          <ol className="space-y-2">
            {versions.map((v) => {
              const isCurrent = current && v.version === current.version;
              return (
                <li
                  key={v.id}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                    isCurrent ? "border-blue-200 bg-blue-50/50" : "border-slate-200"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">v{v.version}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          v.created_by === "ai"
                            ? "bg-violet-100 text-violet-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {v.created_by === "ai" ? "AI" : "User"}
                      </span>
                      {isCurrent && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          current
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {v.change_description ?? "—"}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {formatDate(v.created_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => rollback(v)}
                    disabled={isCurrent || busyVersion !== null}
                    className="ml-3 shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyVersion === v.version ? "Rolling back…" : "Rollback to this"}
                  </button>
                </li>
              );
            })}
            {versions.length === 0 && (
              <li className="py-8 text-center text-sm text-slate-400">
                No versions yet.
              </li>
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}
