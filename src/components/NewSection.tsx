"use client";

// ─────────────────────────────────────────────────────────────
// NewSection — build a section by hand: name it, pick an icon, choose
// what it sits inside, and list its fields. The assistant is the fast
// path, not the only one; adding a section under an existing one is a
// structural decision the owner may just want to make themselves.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { apiFetch } from "@/lib/auth";
import { COLUMN_TYPES } from "@/lib/types";
import { COLUMNS } from "@/lib/capabilities";
import type { ColumnType, ModuleRow } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Group } from "@/components/ui/Group";
import { button, field, fieldOf, label as labelClass, iconButtonCritical } from "@/components/ui/controls";
import { IconPicker } from "@/components/ModuleSettings";
import { Plus, X } from "lucide-react";

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
    <Dialog
      title={initialParentId ? "New section inside" : "New section"}
      description="The fast way is to ask Luke; this is for when you know exactly what you want."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={`${button("plain")} ml-auto`}>
            Cancel
          </button>
          <button onClick={create} disabled={busy || !label.trim()} className={button("primary")}>
            {busy ? "Creating…" : "Create section"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={asError(error)} />}

        <Group title="Details" description="How it shows in the menu, and where.">
          <div>
            <label htmlFor="new-section-name" className={labelClass}>
              Name
            </label>
            <input
              id="new-section-name"
              data-autofocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && label.trim() && !busy && create()}
              placeholder="Repairs, Invoices, Suppliers…"
              className={field}
            />
          </div>

          <div>
            <div className={labelClass}>Icon</div>
            <IconPicker value={icon} onChange={setIcon} />
          </div>

          <div>
            <label htmlFor="new-section-parent" className={labelClass}>
              Sits inside
            </label>
            <select
              id="new-section-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className={field}
            >
              <option value="">Nothing — it sits at the top</option>
              {parents.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nav_label}
                </option>
              ))}
            </select>
          </div>
        </Group>

        <Group title="Fields" description="What each row holds. You can ask Luke for more later.">
          <div>
            <div className="space-y-1.5">
              {fields.map((f, i) => (
                <div key={i} className="flex gap-1.5">
                  <input
                    value={f.label}
                    onChange={(e) => setField(i, { label: e.target.value })}
                    placeholder="Field name"
                    aria-label={`Field ${i + 1} name`}
                    className={`${fieldOf("md")} min-w-0 flex-1`}
                  />
                  <select
                    value={f.type}
                    onChange={(e) => setField(i, { type: e.target.value as ColumnType })}
                    title={COLUMNS[f.type]}
                    aria-label={`Field ${i + 1} type`}
                    className={`${fieldOf("md")} w-32 shrink-0`}
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
                    className={iconButtonCritical}
                  >
                    <X aria-hidden size={15} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setFields((prev) => [...prev, { label: "", type: "text" }])}
              className={`${button("plain", "sm")} mt-1.5 -ml-2.5`}
            >
              <Plus aria-hidden size={14} strokeWidth={2} />
              Add a field
            </button>
          </div>
        </Group>
      </div>
    </Dialog>
  );
}
