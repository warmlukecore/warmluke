"use client";

// ─────────────────────────────────────────────────────────────
// VersionHistory — append-only audit of ui_schemas.
// Rollback NEVER deletes: it copies an old version forward as
// a brand-new version row.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import type { UiSchemaRow } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { button } from "@/components/ui/controls";

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
    <Dialog
      title="Schema version history"
      description="Nothing is ever deleted — rollback adds a new version."
      onClose={onClose}
    >
      {error && (
        <div className="mb-3">
          <ErrorNote error={asError(error)} />
        </div>
      )}
      {versions.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-fg-muted">No versions yet.</p>
      ) : (
        <ol className="divide-y divide-line overflow-hidden rounded-card border border-line">
          {versions.map((v) => {
            const isCurrent = current && v.version === current.version;
            return (
              <li key={v.id} className={`flex items-center gap-3 px-4 py-3 ${isCurrent ? "bg-surface-subdued" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-fg tabular-nums">v{v.version}</span>
                    <span className="rounded-full bg-tone-neutral px-2 py-px text-[11px] font-medium text-tone-neutral-fg">
                      {v.created_by === "ai" ? "AI" : "User"}
                    </span>
                    {isCurrent && (
                      <span className="rounded-full bg-tone-success px-2 py-px text-[11px] font-medium text-tone-success-fg">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-muted">{v.change_description ?? "—"}</div>
                  <div className="text-[11px] text-fg-faint">{formatDate(v.created_at)}</div>
                </div>
                <button
                  onClick={() => rollback(v)}
                  disabled={isCurrent || busyVersion !== null}
                  className={button("secondary", "sm")}
                >
                  {busyVersion === v.version ? "Rolling back…" : "Roll back to this"}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}
