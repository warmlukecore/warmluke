"use client";

// ─────────────────────────────────────────────────────────────
// RecordModal — the owner's own way in and out of their data.
// The form is built from the module's columns, so it fits whatever
// the assistant generated without knowing anything about it.
// ─────────────────────────────────────────────────────────────

import { optionsFor } from "@/lib/filters";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
import { useLinkOptions, useLinkSource } from "@/components/LinkContext";
import { fillFromLinked, narrowFor } from "@/lib/links";
import type { FeatureSchema, RecordRow, SchemaColumn, UiSchema } from "@/lib/types";
import { Check } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Select, type SelectOption } from "@/components/ui/Select";
import { DateField } from "@/components/ui/DateField";
import { badgeLabel } from "@/lib/tone";
import { useFormat } from "@/lib/format";
import { button, field, label, note } from "@/components/ui/controls";

export type RecordDraft = Record<string, unknown>;
type FormState = { draft: RecordDraft; fills: Record<string, Record<string, unknown>>; picked: Record<string, string> };

const rowWords = (s: string) => s.trim().toLowerCase().replace(/^#/, "");
/** A row's label read as the words someone gave for it: "#1042" is "1042"; `within` lets the words be part of it. */
const sameRow = (rowLabel: string, words: string, within: boolean) =>
  within ? rowWords(rowLabel).includes(rowWords(words)) : rowWords(rowLabel) === rowWords(words);

// The choices a dropdown offers, from lib/filters (the design's tryout reads them too).
export { optionsFor };

export function Field({
  col,
  value,
  options,
  onChange,
  narrow = null,
  chosenLabel,
}: {
  col: SchemaColumn;
  value: unknown;
  options: string[];
  /** The value, and for a link the row chosen, for the form to fill from. */
  onChange: (v: string, option?: SelectOption) => void;
  /** A link's rows narrowed by another link already chosen (lib/links.ts). */
  narrow?: { field: string; value: string } | null;
  /** What a link chosen by a search reads as. */
  chosenLabel?: string;
}) {
  const linkOptions = useLinkOptions();
  const source = useLinkSource();
  const fmt = useFormat();
  // A link's rows asked for as they are typed, narrowed as the form says;
  // the same function while nothing it asks by changes, or the list re-asks forever.
  const linkTo = col.type === "link" ? col.linkTo : undefined;
  const narrowField = narrow?.field;
  const narrowValue = narrow?.value;
  const search = useMemo(
    () =>
      source && linkTo
        ? (q: string) =>
            source
              .search(linkTo, q, narrowField && narrowValue ? { field: narrowField, value: narrowValue } : null)
              .then((rows) => rows.map((r) => ({ value: r.id, label: r.label, data: r.data })))
        : undefined,
    [source, linkTo, narrowField, narrowValue]
  );
  const base = field;
  const str = value === null || value === undefined ? "" : String(value);

  // A link is chosen from the target section's rows, never typed: that
  // is the whole point of it not being a copied string.
  if (col.type === "link") {
    const rows = (col.linkTo && linkOptions[col.linkTo]) || [];
    const known = rows.find((r) => r.id === str)?.label ?? chosenLabel;
    return (
      <Select
        label={col.label}
        value={str}
        onChange={onChange}
        search={search}
        chosenLabel={known}
        options={[
          ...rows
            .filter((r) => !narrow || String(r.data?.[narrow.field] ?? "") === narrow.value)
            .map((r) => ({ value: r.id, label: r.label, data: r.data })),
          ...(str && !known ? [{ value: str, label: "(deleted)" }] : []),
        ]}
      />
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
    return (
      <textarea
        aria-label={col.label}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={`${base} resize-y`}
      />
    );
  }

  if ((col.type === "badge" || col.type === "dropdown") && options.length > 0) {
    return (
      <Select
        label={col.label}
        value={str}
        onChange={onChange}
        options={[...options, ...(str && !options.includes(str) ? [str] : [])].map((o) => ({
          value: o,
          label: col.type === "badge" ? badgeLabel(o) : o,
        }))}
      />
    );
  }

  // A day, picked from the app's own month rather than the browser's box.
  if (col.type === "date") {
    return <DateField label={col.label} value={str} onChange={onChange} locale={fmt.locale} />;
  }

  // Native input types give phones the right keyboard and picker.
  const inputType =
    col.type === "number" || col.type === "currency" || col.type === "percent"
      ? "number"
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
      aria-label={col.label}
      value={str}
      onChange={(e) => onChange(e.target.value)}
      step={col.type === "currency" ? "0.01" : undefined}
      placeholder={placeholder}
      className={base}
    />
  );
}

/** One thing that happened to a row (record_events, 0144). */
type RowEvent = {
  id: number;
  at: string;
  actor: string | null;
  via: "person" | "rule" | "system";
  kind: "added" | "changed" | "removed";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

const shown = (v: unknown) =>
  v === null || v === undefined || v === "" ? "blank" : typeof v === "boolean" ? (v ? "Yes" : "blank") : String(v);

/**
 * Who added the row, who changed it, and what each change was, from the
 * database's own record of it: the login that saved, never a typed name.
 * Nothing on a database without it (before 0144), rather than an error.
 */
function RowHistory({ record, columns }: { record: RecordRow; columns: SchemaColumn[] }) {
  const [events, setEvents] = useState<RowEvent[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  // When the history was read: "2 h ago" is from then, not re-read on every render.
  const [now, setNow] = useState(0);
  useEffect(() => {
    let live = true;
    supabase
      .from("record_events")
      .select("id, at, actor, via, kind, before, after")
      .eq("record_id", record.id)
      .order("id", { ascending: false })
      .limit(20)
      .then(async ({ data, error }) => {
        if (!live) return;
        const list = error ? [] : ((data ?? []) as RowEvent[]);
        setNow(Date.now());
        setEvents(list);
        const ids = [
          ...new Set([record.created_by, record.updated_by, ...list.map((e) => e.actor)].filter(Boolean) as string[]),
        ];
        if (ids.length === 0) return;
        const { data: named } = await supabase.rpc("abo_names_for", { p_project: record.project_id, p_ids: ids });
        if (live)
          setNames(
            Object.fromEntries(
              ((named ?? []) as Array<{ user_id: string; name: string }>).map((n) => [n.user_id, n.name])
            )
          );
      });
    return () => {
      live = false;
    };
  }, [record.id, record.project_id, record.created_by, record.updated_by]);

  const labelOf = (f: string) => columns.find((c) => c.field === f)?.label ?? f;
  const who = (id: string | null | undefined) => (id ? (names[id] ?? "someone on the team") : "the system");
  const whatChanged = (e: RowEvent) => {
    const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])].filter(
      (k) => shown(e.before?.[k]) !== shown(e.after?.[k])
    );
    return keys
      .slice(0, 3)
      .map((k) => `${labelOf(k)}: ${shown(e.before?.[k])} → ${shown(e.after?.[k])}`)
      .join(" · ");
  };

  if (!events || (events.length === 0 && !record.created_by)) return null;
  return (
    <div className="border-t border-line pt-3 text-xs text-fg-muted">
      <div>
        Added by {who(record.created_by)}
        {record.updated_by && record.updated_by !== record.created_by
          ? ` · last changed by ${who(record.updated_by)}`
          : ""}
        {events.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="ml-2 font-medium text-link hover:underline">
            {open ? "Hide history" : `History (${events.length})`}
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {events.map((e) => (
            <li key={e.id} className="leading-snug">
              <span className="text-fg">{e.via === "rule" ? `A rule, on ${who(e.actor)}'s save` : who(e.actor)}</span>{" "}
              {e.kind === "added" ? "added it" : e.kind === "removed" ? "removed it" : "changed it"}
              {e.kind === "changed" && whatChanged(e) ? ` — ${whatChanged(e)}` : ""}
              <span className="text-fg-faint"> · {ago(e.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  filled,
}: {
  schema: UiSchema;
  records: RecordRow[];
  /** null = creating a new row. */
  record: RecordRow | null;
  busy: boolean;
  /** A new row filled in for them (lib/screen.ts: by Luke, or a link from their AI), waiting for their Save. A link is its row's words. */
  filled?: Record<string, unknown> | null;
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
    for (const c of columns)
      start[c.field] = record?.data?.[c.field] ?? (c.type !== "link" ? filled?.[c.field] : undefined) ?? "";
    return start;
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const source = useLinkSource();
  // What each link's pick filled (field -> value), and what a searched pick reads as.
  const [filledBy, setFilledBy] = useState<Record<string, Record<string, unknown>>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  // A link filled in as words that no single row answers to: said under it, to pick by hand.
  const [unfound, setUnfound] = useState<Record<string, string>>({});
  const linkOptions = useLinkOptions();
  const targetOf = (moduleId: string) => source?.targetOf(moduleId) ?? null;
  // Only a choice the field is set up with is filled into a badge or a dropdown.
  const fixedOptions = (f: string) => features?.filters?.find((x) => x.field === f)?.options ?? null;
  const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

  /**
   * A field changed. A link fills the form from the row chosen and leaves
   * what the owner typed alone (lib/links.ts); a link it narrowed no longer
   * fits once it points elsewhere, and is cleared with what it filled.
   */
  const change = (col: SchemaColumn, v: string, option?: SelectOption) => {
    if (col.type !== "link") {
      setDraft((prev) => ({ ...prev, [col.field]: v }));
      return;
    }
    const next = pickInto({ draft, fills: filledBy, picked }, col, v, option);
    setDraft(next.draft);
    setFilledBy(next.fills);
    setPicked(next.picked);
    setUnfound((u) => ({ ...u, [col.field]: "" }));
  };

  /** A link picked, worked out from the form as it stands: what it fills, and what it no longer fits. */
  const pickInto = (st: FormState, col: SchemaColumn, v: string, option?: SelectOption): FormState => {
    const was = st.draft;
    const fills = { ...st.fills };
    const target = col.linkTo ? targetOf(col.linkTo) : null;
    let next: RecordDraft = { ...was, [col.field]: v };
    const own = fillFromLinked(
      columns,
      next,
      col,
      { id: v, data: v && option?.data ? option.data : {} },
      target?.columns ?? [],
      fills[col.field] ?? {},
      fixedOptions
    );
    next = own.draft;
    fills[col.field] = own.filled;
    for (const other of columns) {
      if (other === col || other.type !== "link" || isEmpty(next[other.field])) continue;
      const before = narrowFor(other, columns, was, targetOf);
      const after = narrowFor(other, columns, next, targetOf);
      if (before && (before.field !== after?.field || before.value !== after?.value)) {
        next = fillFromLinked(
          columns,
          { ...next, [other.field]: "" },
          other,
          { id: "", data: {} },
          [],
          fills[other.field] ?? {},
          fixedOptions
        ).draft;
        fills[other.field] = {};
      }
    }
    return {
      draft: next,
      fills,
      picked: { ...st.picked, [col.field]: v ? (option?.label ?? st.picked[col.field] ?? "") : "" },
    };
  };

  // A link filled in as words ("#1042"): found as they would search for
  // it, and picked only when one row alone answers to them, so it fills
  // the rest as their own pick would. Once, as soon as the app knows what
  // each link points at: a form opened from a link while the page still
  // loaded searched nothing, and asked them to pick the order by hand.
  const resolving = useRef(false);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    if (!filled || record || resolving.current) return;
    const links = columns.filter((c) => c.type === "link" && c.linkTo && String(filled[c.field] ?? "").trim());
    if (links.some((c) => !targetOf(c.linkTo!))) return;
    resolving.current = true;
    const start: FormState = { draft, fills: filledBy, picked };
    void (async () => {
      let st = start;
      const missing: Record<string, string> = {};
      for (const col of links) {
        const words = String(filled[col.field]).trim();
        const near = (linkOptions[col.linkTo!] ?? []).filter((r) => sameRow(r.label, words, true));
        const rows = near.length ? near : source ? await source.search(col.linkTo!, words, null).catch(() => []) : [];
        const exact = rows.filter((r) => sameRow(r.label, words, false));
        const one = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (one) st = pickInto(st, col, one.id, { value: one.id, label: one.label, data: one.data });
        else missing[col.field] = words;
      }
      if (!open.current) return;
      // Only what the picks changed: anything typed while they were found stays.
      const changed = Object.fromEntries(Object.entries(st.draft).filter(([f, v]) => v !== start.draft[f]));
      setDraft((prev) => ({ ...prev, ...changed }));
      setFilledBy(st.fills);
      setPicked(st.picked);
      setUnfound(missing);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
        {filled && isNew && (
          <p className={note.info}>Filled in for you. Check it, then press Add row: nothing is saved until you do.</p>
        )}
        {columns.map((col) => (
          <div key={col.field}>
            <label className={label}>{col.label}</label>
            <Field
              col={col}
              value={draft[col.field]}
              options={optionMap[col.field] ?? []}
              onChange={(v, option) => change(col, v, option)}
              narrow={col.type === "link" ? narrowFor(col, columns, draft, targetOf) : null}
              chosenLabel={picked[col.field] || undefined}
            />
            {unfound[col.field] && (
              <p className="mt-1 text-[11px] text-fg-faint">
                No one row is &ldquo;{unfound[col.field]}&rdquo;: pick it here.
              </p>
            )}
            {col.type === "link" && Object.keys(filledBy[col.field] ?? {}).length > 0 && (
              <p className="mt-1 text-[11px] text-fg-faint">
                Filled{" "}
                {Object.keys(filledBy[col.field])
                  .map((f) => columns.find((c) => c.field === f)?.label ?? f)
                  .join(", ")}{" "}
                from {picked[col.field] || "the row chosen"}. Change any of them as you like.
              </p>
            )}
          </div>
        ))}
        {record && <RowHistory record={record} columns={schema.columns ?? []} />}
      </div>
    </Dialog>
  );
}
