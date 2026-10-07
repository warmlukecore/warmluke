"use client";

// ─────────────────────────────────────────────────────────────
// The view primitives the assistant chooses between. Which one a
// module uses is a decision made per business problem and stored in
// schema_json.features.view — a repair shop gets a board, a rental
// business gets a calendar, a price list gets a table. Nothing here
// knows what any particular field means.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { FeatureSchema, RecordRow, SchemaColumn, ViewSpec } from "@/lib/types";
import { badgeClasses, badgeLabel, isSettled, knownStatus, type Progress } from "@/lib/tone";
import { evalExpr, truthy } from "@/lib/expr";
import { useFormat, type Formatting } from "@/lib/format";
import { isId, looksLikeCode } from "@/lib/no-ids";
import { isYes } from "@/lib/filters";
import { useLinkLabel } from "@/components/LinkContext";
import { button, fieldOf, type ButtonTone } from "@/components/ui/controls";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Clock, Copy, Inbox, Pencil, Plus, SearchX } from "lucide-react";
import { Field } from "@/components/RecordModal";
import { Select } from "@/components/ui/Select";

/**
 * The first column stays put while the rest scroll under it: a line at its
 * edge and a short fade, so what slides under it reads as sliding, not as
 * a stray mark beside the order number (a half letter read as an icon,
 * 3 Oct). The fade stays inside the next cell's padding.
 */
// Written out whole: the stylesheet is made from class names found in the source.
// Only once the table is scrolled sideways: unscrolled, there is nothing under it.
const STICKY_EDGE =
  "group-data-[scrolled=true]/table:shadow-[inset_-1px_0_0_var(--color-line)] group-data-[scrolled=true]/table:after:pointer-events-none group-data-[scrolled=true]/table:after:absolute group-data-[scrolled=true]/table:after:inset-y-0 group-data-[scrolled=true]/table:after:left-full group-data-[scrolled=true]/table:after:w-3 group-data-[scrolled=true]/table:after:bg-gradient-to-r group-data-[scrolled=true]/table:after:to-transparent";

export function compare(a: unknown, b: unknown, type: SchemaColumn["type"]): number {
  if (type === "number" || type === "currency" || type === "percent") {
    return (Number(a) || 0) - (Number(b) || 0);
  }
  if (type === "date") return new Date(String(a) || 0).getTime() - new Date(String(b) || 0).getTime();
  if (type === "boolean") {
    return Number(isYes(a)) - Number(isYes(b));
  }
  // Times are zero-padded HH:MM, so text order is chronological order.
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/**
 * A code as a person uses one: in a face where 0 and O differ, with a
 * button that copies it and says so for a moment. The click stays here,
 * so copying a number never opens the row. Every code in every view
 * gets this — the value decides (lib/no-ids), not the field's name.
 */
export function CodeValue({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-[13px]">{text}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        aria-label={copied ? "Copied" : `Copy ${text}`}
        title={copied ? "Copied" : "Copy"}
        className="inline-flex h-6 w-6 items-center justify-center rounded-control text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-muted"
      >
        {copied ? (
          <Check aria-hidden size={13} strokeWidth={2.25} className="text-tone-success-fg" />
        ) : (
          <Copy aria-hidden size={13} strokeWidth={2} />
        )}
      </button>
    </span>
  );
}

/** The currency a row's amount is in, when the column names the field that says. */
function amountCurrency(col: SchemaColumn, rec: RecordRow): string | null {
  const c = col.currencyField ? rec.data?.[col.currencyField] : null;
  return typeof c === "string" ? c : null;
}

/** What a column says its value was, from the row (col.was). */
const wasOf = (col: SchemaColumn, rec: RecordRow) => (col.was ? rec.data?.[col.was] : undefined);

export function Cell({
  col,
  value,
  currency,
  was,
}: {
  col: SchemaColumn;
  value: unknown;
  currency?: string | null;
  /** What the column says it was (col.was), shown when it differs: a cancelled order's ₹0 says what it was. */
  was?: unknown;
}) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  // A value that is only an id (a rule that copied one into a text
  // field, say) is nothing to a person: an internal id is never shown.
  if (value === undefined || value === null || value === "" || (col.type !== "link" && isId(value))) {
    return <span className="text-fg-faint">—</span>;
  }
  switch (col.type) {
    case "number": {
      const n = Number(value);
      return <span className="tabular-nums">{Number.isNaN(n) ? String(value) : fmt.number(n)}</span>;
    }
    case "currency": {
      const n = Number(value);
      if (Number.isNaN(n)) return <span className="font-medium tabular-nums">{String(value)}</span>;
      // The shop's own number is the one that can be checked against
      // Shopify, so it is the one in full size. The project-currency
      // figure underneath is a rough conversion at today's rate and is
      // marked as such — it is for a merchant who thinks in rupees,
      // not for anything that has to add up.
      const rough = fmt.approx(n, currency);
      const before = was === null || was === undefined || was === "" ? NaN : Number(was);
      return (
        <span className="font-medium tabular-nums">
          {fmt.money(n, currency)}
          {!Number.isNaN(before) && before !== n && (
            <span className="block text-[11px] font-normal text-fg-muted">was {fmt.money(before, currency)}</span>
          )}
          {rough && <span className="block text-[11px] font-normal text-fg-faint">{rough}</span>}
        </span>
      );
    }
    case "percent": {
      const n = Number(value);
      return <span className="tabular-nums">{Number.isNaN(n) ? String(value) : fmt.percent(n)}</span>;
    }
    case "date":
      return <span className="tabular-nums">{fmt.date(String(value))}</span>;
    case "time":
      return <span className="tabular-nums">{fmt.time(String(value))}</span>;
    // A tick, or nothing: a row not ticked reads as blank, as one never
    // touched does. "No" down a whole column said nothing and looked
    // like something had been decided (an RTO column, 3 Oct).
    case "boolean":
      return isYes(value) ? (
        <span className="inline-flex items-center gap-1 text-tone-success-fg">
          <Check aria-hidden size={13} strokeWidth={2.25} />
          Yes
        </span>
      ) : (
        <span className="text-fg-faint">—</span>
      );
    case "badge":
      return <Badge value={String(value)} />;
    // Links stop the row click so tapping the number calls rather than
    // opening the edit form.
    case "phone":
      return (
        <a
          href={`tel:${String(value).replace(/[^\d+]/g, "")}`}
          onClick={(e) => e.stopPropagation()}
          className="text-link hover:underline"
        >
          {String(value)}
        </a>
      );
    case "email":
      return (
        <a href={`mailto:${String(value)}`} onClick={(e) => e.stopPropagation()} className="text-link hover:underline">
          {String(value)}
        </a>
      );
    case "url": {
      const href = /^https?:\/\//i.test(String(value)) ? String(value) : `https://${String(value)}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-link hover:underline"
        >
          {String(value).replace(/^https?:\/\//i, "")}
        </a>
      );
    }
    case "link":
      return <span className="text-fg">{linkLabel(col.linkTo, value) || "—"}</span>;
    case "longtext":
      return (
        <span className="block max-w-xs truncate text-fg-muted" title={String(value)}>
          {String(value)}
        </span>
      );
    default:
      if (Array.isArray(value)) {
        const items = value.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
        if (items.length === 0) return <span className="text-fg-faint">—</span>;
        return (
          <span className="inline-flex flex-wrap gap-1">
            {items.map((v, i) => (
              <span
                key={`${String(v)}:${i}`}
                className="rounded-lg bg-tone-neutral px-2 py-0.5 text-xs text-fg-muted no-underline"
              >
                {String(v)}
              </span>
            ))}
          </span>
        );
      }
      if (col.type === "barcode" || looksLikeCode(value)) return <CodeValue text={String(value).trim()} />;
      return <span>{String(value)}</span>;
  }
}

/**
 * The mark before a status's words: a hollow ring while something is
 * left to do, half filled while it is under way, filled once it is done.
 */
export function StatusMark({ progress }: { progress: Progress }) {
  return (
    <span
      aria-hidden
      className={`h-2 w-2 shrink-0 rounded-full border-[1.5px] border-current ${progress === "complete" ? "bg-current" : ""}`}
      style={
        progress === "partial" ? { background: "linear-gradient(90deg, currentColor 50%, transparent 50%)" } : undefined
      }
    />
  );
}

/**
 * A value that has a state, drawn by what the state means (lib/tone).
 * A known store status says so in its own words, as a pill with its
 * mark; anything else is its own word in a calm colour.
 */
export function Badge({ value, dot }: { value: string; dot?: boolean }) {
  const progress = knownStatus(value)?.progress;
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap ${badgeClasses(value)}`}
    >
      {progress ? (
        <StatusMark progress={progress} />
      ) : (
        dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
      )}
      {badgeLabel(value)}
    </span>
  );
}

/** Plain text for a field, formatted by its column type. */
export function fieldText(
  fmt: Formatting,
  columns: SchemaColumn[],
  rec: RecordRow,
  field?: string,
  linkLabel?: (linkTo: string | undefined, id: unknown) => string
): string {
  if (!field) return "";
  const col = columns.find((c) => c.field === field);
  const v = rec.data?.[field];
  if (v === undefined || v === null || v === "") return "";
  if (col?.type !== "link" && isId(v)) return "";
  if (!col) return String(v);
  if (col.type === "link") return linkLabel ? linkLabel(col.linkTo, v) : String(v);
  if (col.type === "currency") {
    const n = Number(v);
    const rowCurrency = col.currencyField ? rec.data?.[col.currencyField] : null;
    return Number.isNaN(n) ? String(v) : fmt.money(n, typeof rowCurrency === "string" ? rowCurrency : null);
  }
  if (col.type === "number") {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : fmt.number(n);
  }
  if (col.type === "date") return fmt.date(String(v));
  if (col.type === "time") return fmt.time(String(v));
  if (col.type === "percent") {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : fmt.percent(n);
  }
  if (col.type === "boolean") return isYes(v) ? "Yes" : "";
  return String(v);
}

export interface ViewProps {
  columns: SchemaColumn[];
  records: RecordRow[];
  allRecordCount: number;
  /** Opens the row for editing. Absent in previews, which are read-only. */
  onOpen?: (rec: RecordRow) => void;
  /** Row action buttons the assistant configured for this section. */
  actions?: FeatureSchema["actions"];
  /** Applies one action's field changes to a row. */
  onAction?: (rec: RecordRow, set: Record<string, unknown>, action?: RowButton) => void;
  busyRecordId?: string | null;
  /** Empties the search and filters, offered when they hide every row. */
  onClearFilters?: () => void;
  /** The rows ticked to act on together, and how a tick is made or taken back (the table draws the boxes). */
  selected?: ReadonlySet<string>;
  onSelect?: (ids: string[], on: boolean) => void;
  /** Columns added since this person last looked (0191), marked New in the table's head for this visit. */
  newFields?: ReadonlySet<string>;
  /** Which section this is, to keep the widths its columns were dragged to on this device. */
  widthKey?: string;
  /**
   * Edited in place (7 Oct): these columns' cells are typed into, each
   * change kept as a draft until it is saved or let go.
   */
  editing?: {
    fields: ReadonlySet<string>;
    /** How each column is typed into: the section's own field, or a store column a change writes. */
    kindOf: (field: string) => EditKind;
    /** Why what was typed cannot be saved, or null. */
    problem: (field: string, value: string) => string | null;
    /** A choice field's choices, for the section's own. */
    options: (col: SchemaColumn) => string[];
    draft: (rec: RecordRow, field: string) => string | undefined;
    onDraft: (rec: RecordRow, field: string, value: string) => void;
  };
}

/** How a column is typed into in edit mode: a field of the section's own, or a store column a change writes. */
export type EditKind =
  | { input: "own" }
  | { input: "count" | "money" | "text" | "email" | "phone" | "tags" }
  | { input: "choice"; choices: readonly string[] };

/** Whether what was typed differs from what the row holds, as this column reads it: a tick, a number, words. */
export function differs(col: SchemaColumn, raw: unknown, typed: string): boolean {
  if (col.type === "boolean") return isYes(typed) !== isYes(raw);
  const now = Array.isArray(raw) ? raw.join(", ") : raw === null || raw === undefined ? "" : String(raw);
  const t = typed.trim();
  if (NUMERIC.has(col.type) && t !== "" && now !== "" && Number.isFinite(Number(t))) return Number(t) !== Number(now);
  return t !== now.trim();
}

/** Own fields picked rather than typed: a day, a choice, a row of another section (a tick is a tick box). */
const PICKED: ReadonlySet<SchemaColumn["type"]> = new Set(["date", "badge", "dropdown", "link"]);

/** A cell being edited: what it holds now, typed over or picked; changed, it says so, and red when it cannot be saved. */
function EditCell({
  col,
  rec,
  editing,
}: {
  col: SchemaColumn;
  rec: RecordRow;
  editing: NonNullable<ViewProps["editing"]>;
}) {
  const raw = rec.data?.[col.field];
  const now = Array.isArray(raw) ? raw.join(", ") : raw === null || raw === undefined ? "" : String(raw);
  const typed = editing.draft(rec, col.field);
  const kind = editing.kindOf(col.field);
  const changed = typed !== undefined && differs(col, raw, typed);
  const wrong = changed ? editing.problem(col.field, typed) : null;
  const put = (v: string) => editing.onDraft(rec, col.field, v);
  // Changed is a dot beside the box, not a second ring on it: the field's own ring is its focus.
  const dot = changed && (
    <span
      aria-hidden
      className={`absolute top-1/2 -left-2.5 size-1.5 -translate-y-1/2 rounded-full ${wrong ? "bg-signal-critical" : "bg-signal-info"}`}
    />
  );
  const said = `${col.label} of this row${changed ? ", changed" : ""}`;

  if (kind.input === "own" && col.type === "boolean") {
    return (
      <span className="relative inline-flex items-center">
        {dot}
        <TickBox label={said} checked={isYes(typed ?? raw)} onChange={(on) => put(on ? "true" : "false")} />
      </span>
    );
  }

  if (kind.input === "choice" || (kind.input === "own" && PICKED.has(col.type))) {
    return (
      <span className="relative block min-w-36" onClick={(e) => e.stopPropagation()}>
        {dot}
        {kind.input === "choice" ? (
          <Select
            label={said}
            value={typed ?? now}
            onChange={put}
            options={[
              ...kind.choices,
              ...(now && !kind.choices.some((c) => c.toLowerCase() === now.toLowerCase()) ? [now] : []),
            ].map((c) => ({ value: c, label: badgeLabel(c) }))}
          />
        ) : (
          <Field col={{ ...col, label: said }} value={typed ?? raw} options={editing.options(col)} onChange={put} />
        )}
      </span>
    );
  }

  const counted = kind.input === "count" || kind.input === "money" || (kind.input === "own" && NUMERIC.has(col.type));
  const type =
    kind.input === "email" || col.type === "email"
      ? "email"
      : kind.input === "phone" || col.type === "phone"
        ? "tel"
        : col.type === "url"
          ? "url"
          : "text";
  return (
    <span className="relative inline-flex w-full items-center justify-end">
      {dot}
      <input
        type={type}
        value={typed ?? now}
        onChange={(e) => put(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        // As in a spreadsheet: Enter goes down the column (Shift+Enter up), Escape puts the cell back.
        onKeyDown={(e) => {
          if (e.key === "Escape" && changed) {
            e.stopPropagation();
            put(now);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = e.currentTarget.closest("tr");
            const next = (
              e.shiftKey ? row?.previousElementSibling : row?.nextElementSibling
            )?.querySelector<HTMLInputElement>(`input[data-edit="${CSS.escape(col.field)}"]`);
            next?.focus();
            next?.select();
          }
        }}
        data-edit={col.field}
        inputMode={counted ? "decimal" : undefined}
        aria-label={said}
        aria-invalid={wrong ? true : undefined}
        title={wrong ?? undefined}
        className={`${fieldOf("sm")} ${counted ? "w-24 text-right" : "w-full min-w-40"} tabular-nums`}
      />
    </span>
  );
}

/** A column with no width of its own stops here: a long name is cut, and said whole on hover. */
const CELL_CAP = 320;
const CELL_MIN = 64;
const widthsAt = (key: string) => `abo_widths:${key}`;
/** A cell's words for its hover, when it is words or a number: what a cut cell holds in full. */
const plainOf = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
function keptWidths(key: string | undefined): Record<string, number> {
  if (!key) return {};
  try {
    const kept = JSON.parse(localStorage.getItem(widthsAt(key)) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(kept).filter(([, w]) => typeof w === "number" && w >= CELL_MIN)) as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

/**
 * A column's edge, dragged to make it wider or narrower, as in a
 * spreadsheet (7 Oct): arrows move it by a step, a double press gives it
 * back its own width. Kept per section on this device.
 */
function ColumnEdge({
  label,
  width,
  onWidth,
}: {
  label: string;
  width: number | undefined;
  onWidth: (w: number | undefined, done: boolean) => void;
}) {
  const start = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const from = e.clientX;
    const was = th?.getBoundingClientRect().width ?? width ?? CELL_CAP;
    let last = was;
    const move = (m: PointerEvent) => {
      last = Math.min(800, Math.max(CELL_MIN, Math.round(was + m.clientX - from)));
      onWidth(last, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onWidth(last, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Width of ${label}`}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={start}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onWidth(undefined, true);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const at = width ?? e.currentTarget.parentElement?.getBoundingClientRect().width ?? CELL_CAP;
        onWidth(Math.min(800, Math.max(CELL_MIN, Math.round(at + (e.key === "ArrowRight" ? 24 : -24)))), true);
      }}
      className="absolute top-1.5 right-0 bottom-1.5 z-10 w-1.5 cursor-col-resize rounded-full transition-colors hover:bg-line-strong focus-visible:bg-focus focus-visible:outline-none"
    />
  );
}

/**
 * The row as an expression sees it: its fields plus its id, so a guard
 * or an action can refer to the row itself.
 */
function withId(rec: RecordRow): Record<string, unknown> {
  return { ...rec.data, id: rec.id };
}

/**
 * What a row button writes to this row, or null when its guard does not
 * offer it there: the one button's own logic, for a press on many rows at
 * once (BulkBar), so ticking twenty orders and pressing Mark RTO does what
 * twenty presses would, and nothing a press could not.
 */
export function actionChange(
  a: NonNullable<FeatureSchema["actions"]>[number],
  rec: RecordRow
): Record<string, unknown> | null {
  if (a.when !== undefined && !truthy(evalExpr(a.when, withId(rec)))) return null;
  const out: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(a.set)) out[f] = evalExpr(v, withId(rec));
  return out;
}

/** A row action is offered only when its guard matches that row. */
function actionsFor(actions: FeatureSchema["actions"], rec: RecordRow): NonNullable<FeatureSchema["actions"]> {
  return (actions ?? []).filter((a) => a.when === undefined || truthy(evalExpr(a.when, withId(rec))));
}

/** A row's button as a view draws it: "waits" when this person's press goes to the owner for a yes (0183). */
export type RowButton = NonNullable<FeatureSchema["actions"]>[number] & { waits?: boolean };

const ACTION_TONES: Record<string, ButtonTone> = {
  primary: "primary",
  danger: "critical",
  neutral: "secondary",
};

export function ActionButtons({
  rec,
  actions,
  onAction,
  busy,
}: {
  rec: RecordRow;
  actions: FeatureSchema["actions"];
  onAction?: (rec: RecordRow, set: Record<string, unknown>, action?: RowButton) => void;
  busy?: boolean;
}) {
  const available = actionsFor(actions, rec);
  if (available.length === 0 || !onAction) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((a) => (
        <button
          key={a.label}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            // Values are expressions too, so a button can stamp today's
            // date or compute a total, not just write constants.
            const resolved: Record<string, unknown> = {};
            for (const [f, v] of Object.entries(a.set)) {
              resolved[f] = evalExpr(v, withId(rec));
            }
            onAction(rec, resolved, a);
          }}
          title={(a as RowButton).waits ? "Goes to the owner for a yes" : undefined}
          className={button(ACTION_TONES[a.style ?? "neutral"] ?? "secondary", "sm")}
        >
          {(a as RowButton).waits && <Clock aria-hidden size={12} strokeWidth={2} />}
          {a.label}
          {(a as RowButton).waits && <span className="sr-only"> (goes to the owner for a yes)</span>}
        </button>
      ))}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────

/** Columns read as amounts: set to the right, so their digits line up. */
const NUMERIC: ReadonlySet<SchemaColumn["type"]> = new Set(["number", "currency", "percent"]);

/**
 * The table every section can be. Its head is a band that stays in view
 * while the rows scroll under it, and its first column (what the row is)
 * stays at the left while the others scroll across. A row whose statuses
 * are all settled (Paid, Fulfilled) is drawn muted, so what still needs
 * the merchant stands out; a cancelled one is struck.
 */
export function TableView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  onClearFilters,
  sort,
  onSort,
  selected,
  onSelect,
  newFields,
  widthKey,
  editing,
}: ViewProps & {
  sort: { field: string; dir: "asc" | "desc" } | null;
  onSort: (field: string) => void;
}) {
  const hasActions = (actions?.length ?? 0) > 0 && !!onAction;
  const [widths, setWidths] = useState<Record<string, number>>(() => keptWidths(widthKey));
  useEffect(() => setWidths(keptWidths(widthKey)), [widthKey]);
  const setWidth = (field: string, w: number | undefined, done: boolean) =>
    setWidths((was) => {
      const next = { ...was };
      if (w === undefined) delete next[field];
      else next[field] = w;
      if (done && widthKey)
        try {
          localStorage.setItem(widthsAt(widthKey), JSON.stringify(next));
        } catch {
          // A browser that keeps nothing still resizes for this visit.
        }
      return next;
    });
  // What a cell may take: its column's own width, else the cap, less the cell's padding.
  const room = (field: string) => (widths[field] ?? CELL_CAP) - 24;
  // The rows to act on together: ticked in the first column, every one shown from its head.
  const ids = records.map((r) => r.id);
  const allTicked = ids.length > 0 && ids.every((id) => selected?.has(id));
  const someTicked = !allTicked && ids.some((id) => selected?.has(id));
  const statusFields = columns.filter((c) => c.type === "badge").map((c) => c.field);
  // Each cell paints the row's background, so the pinned first cell covers what scrolls under it.
  // The wrapper's padding sets the band in from the card's edge; what is pinned sits on the edge
  // itself (-1.5), or the rows would show through that strip as they scroll.
  const cellBg = `bg-surface transition-colors ${onOpen ? "group-hover:bg-surface-hover" : ""}`;
  return (
    <div
      className="group/table min-h-0 overflow-auto p-1.5 thin-scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        const scrolled = String(el.scrollLeft > 0);
        if (el.dataset.scrolled !== scrolled) el.dataset.scrolled = scrolled;
      }}
    >
      <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
        <thead>
          <tr>
            {columns.map((col, i) => {
              const dir = sort?.field === col.field ? sort.dir : null;
              return (
                <th
                  key={col.field}
                  scope="col"
                  style={widths[col.field] ? { width: widths[col.field], minWidth: widths[col.field] } : undefined}
                  aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
                  className={`sticky -top-1.5 bg-surface-subdued p-0 text-xs font-medium whitespace-nowrap text-fg-muted first:rounded-l-lg last:rounded-r-lg ${
                    i === 0
                      ? `-left-1.5 z-20 ${STICKY_EDGE} group-data-[scrolled=true]/table:after:from-surface-subdued`
                      : "z-10"
                  }`}
                >
                  {i === 0 && onSelect ? (
                    <div className="flex items-center">
                      <TickBox
                        label={allTicked ? "Untick every row shown" : "Tick every row shown"}
                        checked={allTicked}
                        mixed={someTicked}
                        onChange={(on) => onSelect(ids, on)}
                      />
                      <SortButton
                        col={col}
                        dir={dir}
                        onSort={onSort}
                        fresh={newFields?.has(col.field)}
                        editable={!!editing?.fields.has(col.field)}
                      />
                    </div>
                  ) : (
                    <SortButton
                      col={col}
                      dir={dir}
                      onSort={onSort}
                      fresh={newFields?.has(col.field)}
                      editable={!!editing?.fields.has(col.field)}
                    />
                  )}
                  <ColumnEdge
                    label={col.label}
                    width={widths[col.field]}
                    onWidth={(w, done) => setWidth(col.field, w, done)}
                  />
                </th>
              );
            })}
            {hasActions && (
              <th scope="col" className="sticky -top-1.5 z-10 rounded-r-lg bg-surface-subdued">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {records.map((rec) => {
            // The store's own mark for an order that no longer stands.
            // Struck, not hidden: it happened, and it still counts as one.
            const struck = !!rec.data?.cancelled_at;
            const statuses = statusFields.map((f) => String(rec.data?.[f] ?? "")).filter((v) => knownStatus(v));
            const settled = statuses.length > 0 && statuses.every(isSettled);
            return (
              <tr
                key={rec.id}
                onClick={() => onOpen?.(rec)}
                className={`group ${onOpen ? "cursor-pointer" : ""} ${
                  struck ? "text-fg-muted line-through" : settled ? "text-fg-muted" : "text-fg"
                }`}
              >
                {columns.map((col, i) => (
                  <td
                    key={col.field}
                    className={`h-11 border-b border-line px-3 align-middle whitespace-nowrap ${cellBg} ${
                      NUMERIC.has(col.type) ? "text-right" : ""
                    } ${i === 0 ? `sticky -left-1.5 z-[1] font-semibold ${STICKY_EDGE} group-data-[scrolled=true]/table:after:from-surface ${onOpen ? "group-hover:after:from-surface-hover" : ""}` : ""}`}
                  >
                    {i === 0 && onSelect ? (
                      <div className="flex items-center gap-2.5">
                        <TickBox
                          label="Tick this row"
                          checked={!!selected?.has(rec.id)}
                          onChange={(on) => onSelect([rec.id], on)}
                        />
                        {/* The first column is edited too: a customer's name, a product's title. */}
                        {editing?.fields.has(col.field) ? (
                          <EditCell col={col} rec={rec} editing={editing} />
                        ) : (
                          <div
                            className="min-w-0 truncate"
                            style={{ maxWidth: room(col.field) - 32 }}
                            title={plainOf(rec.data?.[col.field])}
                          >
                            <Cell
                              col={col}
                              value={rec.data?.[col.field]}
                              currency={amountCurrency(col, rec)}
                              was={wasOf(col, rec)}
                            />
                          </div>
                        )}
                      </div>
                    ) : editing?.fields.has(col.field) ? (
                      <EditCell col={col} rec={rec} editing={editing} />
                    ) : (
                      <div
                        className="truncate"
                        style={{ maxWidth: room(col.field) }}
                        title={plainOf(rec.data?.[col.field])}
                      >
                        <Cell
                          col={col}
                          value={rec.data?.[col.field]}
                          currency={amountCurrency(col, rec)}
                          was={wasOf(col, rec)}
                        />
                      </div>
                    )}
                  </td>
                ))}
                {hasActions && (
                  <td className={`border-b border-line px-3 text-right ${cellBg}`}>
                    <ActionButtons rec={rec} actions={actions} onAction={onAction} busy={busyRecordId === rec.id} />
                  </td>
                )}
              </tr>
            );
          })}
          {records.length === 0 && (
            <tr>
              <td colSpan={columns.length + (hasActions ? 1 : 0)}>
                <EmptyState total={allRecordCount} onClear={onClearFilters} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A column's head: its name, and the order its rows are in when it sorts them. */
function SortButton({
  col,
  dir,
  onSort,
  fresh = false,
  editable = false,
}: {
  col: SchemaColumn;
  dir: "asc" | "desc" | null;
  onSort: (field: string) => void;
  /** Added since they last looked: marked New. */
  fresh?: boolean;
  /** Typed into in edit mode: marked with a pencil. */
  editable?: boolean;
}) {
  return (
    <button
      type="button"
      aria-description={fresh ? "New since you last looked" : undefined}
      onClick={() => onSort(col.field)}
      className={`group/sort flex h-9 w-full items-center gap-1 rounded-lg px-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
        NUMERIC.has(col.type) ? "justify-end" : ""
      } ${dir ? "text-fg" : ""}`}
    >
      {editable && <Pencil aria-hidden size={11} strokeWidth={2} className="shrink-0 text-signal-info" />}
      {col.label}
      {fresh && (
        <span
          aria-hidden
          className="rounded-full bg-tone-info px-1.5 text-[10px] leading-4 font-medium text-tone-info-fg normal-case"
        >
          New
        </span>
      )}
      {dir === "asc" ? (
        <ArrowUp aria-hidden size={12} strokeWidth={2} />
      ) : dir === "desc" ? (
        <ArrowDown aria-hidden size={12} strokeWidth={2} />
      ) : (
        <ArrowUpDown
          aria-hidden
          size={12}
          strokeWidth={2}
          className="text-fg-faint opacity-0 transition-opacity group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100"
        />
      )}
    </button>
  );
}

/** A tick to choose a row (or every row shown) to act on, that does not open the row it sits in. */
export function TickBox({
  label,
  checked,
  mixed = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = mixed;
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
      className="ml-1 size-4 shrink-0 cursor-pointer rounded accent-primary"
    />
  );
}

// ── Board ────────────────────────────────────────────────────

export function BoardView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  onClearFilters,
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "board" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  const groupCol = columns.find((c) => c.field === view.groupBy);
  // Column order comes from the data itself, so a stage nobody has used
  // yet simply doesn't appear rather than showing an empty ghost column.
  const groups: string[] = [];
  for (const r of records) {
    const g = String(r.data?.[view.groupBy] ?? "").trim() || "Unassigned";
    if (!groups.includes(g)) groups.push(g);
  }
  if (groups.length === 0) return <EmptyState total={allRecordCount} onClear={onClearFilters} />;

  const cardFields = (view.cardFields ?? [])
    .map((f) => columns.find((c) => c.field === f))
    .filter((c): c is SchemaColumn => !!c);

  return (
    <div className="flex gap-3 overflow-x-auto p-3 thin-scroll">
      {groups.map((g) => {
        const rows = records.filter((r) => (String(r.data?.[view.groupBy] ?? "").trim() || "Unassigned") === g);
        return (
          <div key={g} className="flex w-[72vw] max-w-64 shrink-0 flex-col rounded-card bg-surface-subdued p-2 sm:w-64">
            <div className="flex items-center justify-between px-1.5 pb-2">
              <Badge value={g} dot />
              <span className="text-[11px] font-medium text-fg-faint tabular-nums">{rows.length}</span>
            </div>
            <div className="space-y-2">
              {rows.map((rec) => (
                <div
                  key={rec.id}
                  onClick={() => onOpen?.(rec)}
                  className={`rounded-lg bg-surface p-2.5 shadow-card transition-shadow hover:shadow-raised ${
                    onOpen ? "cursor-pointer" : ""
                  }`}
                >
                  <div className="text-xs font-semibold text-fg">
                    {fieldText(fmt, columns, rec, view.cardTitle, linkLabel) || "Untitled"}
                  </div>
                  {cardFields.map((col) => {
                    const val = fieldText(fmt, columns, rec, col.field, linkLabel);
                    if (!val) return null;
                    return (
                      <div key={col.field} className="mt-1 flex gap-1.5 text-[11px] leading-snug">
                        <span className="shrink-0 text-fg-faint">{col.label}</span>
                        <span className="min-w-0 truncate text-fg-muted">
                          <Cell
                            col={col}
                            value={rec.data?.[col.field]}
                            currency={amountCurrency(col, rec)}
                            was={wasOf(col, rec)}
                          />
                        </span>
                      </div>
                    );
                  })}
                  <div className="mt-2 empty:mt-0">
                    <ActionButtons rec={rec} actions={actions} onAction={onAction} busy={busyRecordId === rec.id} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {groupCol === undefined && (
        <div className="self-center text-xs text-fg-faint">
          Grouping field &ldquo;{view.groupBy}&rdquo; is missing from this schema.
        </div>
      )}
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────

export function CalendarView({
  columns,
  records,
  allRecordCount,
  onOpen,
  onClearFilters,
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "calendar" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  const dated = records
    .map((r) => ({ rec: r, raw: String(r.data?.[view.dateField] ?? "") }))
    .map((x) => ({ ...x, d: new Date(x.raw) }))
    .filter((x) => !Number.isNaN(x.d.getTime()));

  if (dated.length === 0) return <EmptyState total={allRecordCount} onClear={onClearFilters} />;

  // Anchor on the month with the most entries so the owner lands on the
  // busy month rather than an empty "today".
  const monthCounts = new Map<string, number>();
  for (const x of dated) {
    const k = `${x.d.getFullYear()}-${x.d.getMonth()}`;
    monthCounts.set(k, (monthCounts.get(k) ?? 0) + 1);
  }
  const [anchorY, anchorM] = [...monthCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split("-")
    .map(Number);

  const first = new Date(anchorY, anchorM, 1);
  const daysInMonth = new Date(anchorY, anchorM + 1, 0).getDate();
  const leading = first.getDay();
  const cells: Array<number | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<number, typeof dated>();
  for (const x of dated) {
    if (x.d.getFullYear() !== anchorY || x.d.getMonth() !== anchorM) continue;
    const arr = byDay.get(x.d.getDate()) ?? [];
    arr.push(x);
    byDay.set(x.d.getDate(), arr);
  }
  const outside = dated.length - [...byDay.values()].reduce((a, b) => a + b.length, 0);

  return (
    <div className="overflow-x-auto p-3 thin-scroll">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <div className="font-display text-sm font-semibold text-fg">
          {first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        {outside > 0 && <div className="text-[11px] text-fg-faint">{outside} more in other months</div>}
      </div>
      <div className="grid min-w-[560px] grid-cols-7 gap-px overflow-hidden rounded-lg bg-line">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-surface-subdued px-2 py-1.5 text-center text-[10px] font-semibold tracking-wider text-fg-muted uppercase"
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          const entries = day ? (byDay.get(day) ?? []) : [];
          return (
            <div key={i} className={`min-h-[84px] bg-surface p-1.5 ${day === null ? "bg-surface-subdued/60" : ""}`}>
              {day !== null && (
                <>
                  <div className="mb-1 text-[11px] font-medium text-fg-faint tabular-nums">{day}</div>
                  <div className="space-y-1">
                    {entries.slice(0, 3).map(({ rec }) => {
                      const colour = view.colorBy
                        ? badgeClasses(String(rec.data?.[view.colorBy] ?? ""))
                        : "bg-tone-info text-tone-info-fg";
                      return (
                        <div
                          key={rec.id}
                          onClick={() => onOpen?.(rec)}
                          title={fieldText(fmt, columns, rec, view.titleField, linkLabel)}
                          className={`truncate rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${colour} ${
                            onOpen ? "cursor-pointer hover:brightness-95" : ""
                          }`}
                        >
                          {fieldText(fmt, columns, rec, view.titleField, linkLabel) || "—"}
                        </div>
                      );
                    })}
                    {entries.length > 3 && (
                      <div className="px-1 text-[10px] text-fg-faint">+{entries.length - 3} more</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────

export function CardsView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  onClearFilters,
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "cards" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (records.length === 0) return <EmptyState total={allRecordCount} onClear={onClearFilters} />;
  const extra = (view.fields ?? [])
    .map((f) => columns.find((c) => c.field === f))
    .filter((c): c is SchemaColumn => !!c);

  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {records.map((rec) => (
        <div
          key={rec.id}
          onClick={() => onOpen?.(rec)}
          className={`rounded-card bg-surface p-3.5 shadow-card transition-shadow hover:shadow-raised ${
            onOpen ? "cursor-pointer" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">
                {fieldText(fmt, columns, rec, view.titleField, linkLabel) || "Untitled"}
              </div>
              {view.subtitleField && (
                <div className="truncate text-xs text-fg-muted">
                  {fieldText(fmt, columns, rec, view.subtitleField, linkLabel)}
                </div>
              )}
            </div>
            {view.badgeField && rec.data?.[view.badgeField] != null && (
              <Badge value={String(rec.data[view.badgeField])} />
            )}
          </div>
          {extra.length > 0 && (
            <dl className="mt-2.5 space-y-1 border-t border-line pt-2.5">
              {extra.map((col) => {
                const val = fieldText(fmt, columns, rec, col.field, linkLabel);
                if (!val) return null;
                return (
                  <div key={col.field} className="flex justify-between gap-2 text-[11px]">
                    <dt className="text-fg-faint">{col.label}</dt>
                    <dd className="truncate font-medium text-fg">
                      <Cell
                        col={col}
                        value={rec.data?.[col.field]}
                        currency={amountCurrency(col, rec)}
                        was={wasOf(col, rec)}
                      />
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          <div className="mt-2.5 empty:mt-0">
            <ActionButtons rec={rec} actions={actions} onAction={onAction} busy={busyRecordId === rec.id} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── List ─────────────────────────────────────────────────────

/** A named field of a row, drawn as the table would draw it; a field the section no longer has is its raw text. */
function FieldValue({ columns, rec, field }: { columns: SchemaColumn[]; rec: RecordRow; field: string }) {
  const col = columns.find((c) => c.field === field);
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (!col) return <>{fieldText(fmt, columns, rec, field, linkLabel)}</>;
  return <Cell col={col} value={rec.data?.[field]} currency={amountCurrency(col, rec)} was={wasOf(col, rec)} />;
}

export function ListView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  onClearFilters,
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "list" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (records.length === 0) return <EmptyState total={allRecordCount} onClear={onClearFilters} />;
  return (
    <ul className="divide-y divide-line">
      {records.map((rec) => (
        <li
          key={rec.id}
          onClick={() => onOpen?.(rec)}
          className={`flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-subdued/70 ${
            onOpen ? "cursor-pointer" : ""
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">
              {fieldText(fmt, columns, rec, view.titleField, linkLabel) || "Untitled"}
            </div>
            {view.secondaryField && (
              <div className="truncate text-[11px] text-fg-muted">
                <FieldValue columns={columns} rec={rec} field={view.secondaryField} />
              </div>
            )}
          </div>
          {view.metaField && (
            <div className="shrink-0 text-[11px] text-fg-muted tabular-nums">
              <FieldValue columns={columns} rec={rec} field={view.metaField} />
            </div>
          )}
          {view.badgeField && rec.data?.[view.badgeField] != null && (
            <Badge value={String(rec.data[view.badgeField])} />
          )}
          <ActionButtons rec={rec} actions={actions} onAction={onAction} busy={busyRecordId === rec.id} />
        </li>
      ))}
    </ul>
  );
}

// ── Shared ───────────────────────────────────────────────────

/**
 * What a section says with no rows to show: that there are none yet
 * (with the way to add the first, where rows can be added), or that the
 * search and filters hide them all (with the way to clear them).
 */
export function EmptyState({ total, onClear, onAdd }: { total: number; onClear?: () => void; onAdd?: () => void }) {
  const none = total === 0;
  const Glyph = none ? Inbox : SearchX;
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-subdued text-fg-faint">
        <Glyph aria-hidden size={18} strokeWidth={1.75} />
      </span>
      <div className="mt-3 text-sm font-medium text-fg">{none ? "Nothing here yet" : "Nothing matches"}</div>
      <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-fg-muted">
        {none ? "Rows show up here as soon as there are any." : "No row fits the current search or filters."}
      </p>
      {none && onAdd && (
        <button onClick={onAdd} className={`${button("primary", "sm")} mt-4`}>
          <Plus aria-hidden size={14} strokeWidth={2} />
          Add the first one
        </button>
      )}
      {!none && onClear && (
        <button onClick={onClear} className={`${button("secondary", "sm")} mt-4`}>
          Clear search and filters
        </button>
      )}
    </div>
  );
}
