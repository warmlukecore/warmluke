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
import { Icon } from "@/components/ui/Icon";
import { Dialog } from "@/components/ui/Dialog";
import { Group } from "@/components/ui/Group";
import { button, field, hint, label as labelClass, note } from "@/components/ui/controls";


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
    <Dialog
      title="Section settings"
      description={module.nav_label}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={`${button("plain")} ml-auto`}>
            Cancel
          </button>
          <button onClick={save} disabled={busy || !dirty || !label.trim()} className={button("primary")}>
            {busy && !confirmingDelete ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={asError(error)} />}

        <Group title="Details" description="How it shows in the menu, and where.">
        <div>
          <label htmlFor="section-name" className={labelClass}>
            Name
          </label>
          <input id="section-name" value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
        </div>

        <div>
          <div className={labelClass}>Icon</div>
          <IconPicker value={icon} onChange={setIcon} />
        </div>

        <div>
          <label htmlFor="section-parent" className={labelClass}>
            Sits inside
          </label>
          <select
            id="section-parent"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            disabled={hasChildren}
            className={field}
          >
            <option value="">Nothing — it sits at the top</option>
            {parentOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nav_label}
              </option>
            ))}
          </select>
          {hasChildren && (
            <div className={hint}>
              This section has {impact!.children.length} inside it, so it stays at the top.
              Sections nest one level only.
            </div>
          )}
        </div>
        </Group>

        <Group title="Rows" description="Where this section's rows come from.">
        <div>
          <label htmlFor="section-source" className={labelClass}>
            Rows come from
          </label>
          <select id="section-source" value={source} onChange={(e) => setSource(e.target.value)} className={field}>
            <option value="">Rows added in this section</option>
            {Object.entries(STORE_TABLES).map(([table, spec]) => (
              <option key={table} value={table}>
                {spec.label}
              </option>
            ))}
          </select>
          <div className={hint}>
            {source
              ? // Said before they save, not after: switching replaces
                // the columns, and rows they typed stop being shown.
                "These rows come from Shopify and cannot be edited here — the import owns them. Rows added in this section stay in the database but are hidden while this is on, and the columns are replaced to match the store."
              : "This section holds rows you or your staff add."}
          </div>
        </div>
        </Group>

        <Group title="Delete this section" danger>
          {!confirmingDelete ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-fg-muted">
                {impact ? `${impact.records} row${impact.records === 1 ? "" : "s"} go with it.` : "Its rows go with it."}
              </p>
              <button onClick={() => setConfirmingDelete(true)} className={button("critical-secondary", "sm")}>
                Delete section
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className={note.critical}>
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
                <div className={note.attention}>
                  These rules write to this section and would stop working:{" "}
                  {impact!.blockedBy.join(", ")}. Turn them off in Rules first.
                </div>
              )}
              <input
                autoFocus
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={`Type "${module.nav_label}" to confirm`}
                aria-label="Type the section name to confirm"
                className={field}
              />
              <div className="flex gap-2">
                <button onClick={remove} disabled={busy || !canDelete || blocked} className={button("critical")}>
                  {busy ? "Deleting…" : "Delete permanently"}
                </button>
                <button
                  onClick={() => {
                    setConfirmingDelete(false);
                    setConfirm("");
                  }}
                  className={button("plain")}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Group>
      </div>
    </Dialog>
  );
}

/** The section icons, as a row of buttons; shared with a new section. */
export function IconPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1.5">
      {ALLOWED_ICONS.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={name}
          onClick={() => onChange(name)}
          title={name}
          className={`flex h-8 w-8 items-center justify-center rounded-control border transition-colors ${
            value === name
              ? "border-fg bg-surface-hover text-fg"
              : "border-line text-fg-muted hover:bg-surface-hover hover:text-fg"
          }`}
        >
          <Icon name={name} size={16} />
        </button>
      ))}
    </div>
  );
}
