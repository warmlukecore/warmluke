"use client";

// ─────────────────────────────────────────────────────────────
// The view primitives the assistant chooses between. Which one a
// module uses is a decision made per business problem and stored in
// schema_json.features.view — a repair shop gets a board, a rental
// business gets a calendar, a price list gets a table. Nothing here
// knows what any particular field means.
// ─────────────────────────────────────────────────────────────

import type { FeatureSchema, RecordRow, SchemaColumn, ViewSpec } from "@/lib/types";
import { badgeColorFor } from "@/lib/types";
import { evalExpr, truthy } from "@/lib/expr";
import { useFormat, type Formatting } from "@/lib/format";
import { useLinkLabel } from "@/components/LinkContext";



export function compare(a: unknown, b: unknown, type: SchemaColumn["type"]): number {
  if (type === "number" || type === "currency" || type === "percent") {
    return (Number(a) || 0) - (Number(b) || 0);
  }
  if (type === "date") return new Date(String(a) || 0).getTime() - new Date(String(b) || 0).getTime();
  if (type === "boolean") {
    const truthyOf = (v: unknown) => (v === true || v === "true" || v === "yes" || v === 1 ? 1 : 0);
    return truthyOf(a) - truthyOf(b);
  }
  // Times are zero-padded HH:MM, so text order is chronological order.
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export function Cell({ col, value }: { col: SchemaColumn; value: unknown }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (value === undefined || value === null || value === "") {
    return <span className="text-slate-300">—</span>;
  }
  switch (col.type) {
    case "number": {
      const n = Number(value);
      return <span className="tabular-nums">{Number.isNaN(n) ? String(value) : fmt.number(n)}</span>;
    }
    case "currency": {
      const n = Number(value);
      return (
        <span className="font-medium tabular-nums">
          {Number.isNaN(n) ? String(value) : fmt.money(n)}
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
    case "boolean": {
      const yes = value === true || value === "true" || value === "yes" || value === 1;
      return (
        <span className={yes ? "text-emerald-600" : "text-slate-300"}>{yes ? "✓ Yes" : "No"}</span>
      );
    }
    case "badge":
      return <Badge value={String(value)} />;
    // Links stop the row click so tapping the number calls rather than
    // opening the edit form.
    case "phone":
      return (
        <a
          href={`tel:${String(value).replace(/[^\d+]/g, "")}`}
          onClick={(e) => e.stopPropagation()}
          className="text-blue-600 hover:underline"
        >
          {String(value)}
        </a>
      );
    case "email":
      return (
        <a
          href={`mailto:${String(value)}`}
          onClick={(e) => e.stopPropagation()}
          className="text-blue-600 hover:underline"
        >
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
          className="text-blue-600 hover:underline"
        >
          {String(value).replace(/^https?:\/\//i, "")}
        </a>
      );
    }
    case "link":
      return <span className="text-slate-700">{linkLabel(col.linkTo, value) || "—"}</span>;
    case "longtext":
      return (
        <span className="block max-w-xs truncate text-slate-600" title={String(value)}>
          {String(value)}
        </span>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

export function Badge({ value, dot }: { value: string; dot?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${badgeColorFor(value)}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />}
      {value}
    </span>
  );
}

/** Plain text for a field, formatted by its column type. */
function fieldText(
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
  if (!col) return String(v);
  if (col.type === "link") return linkLabel ? linkLabel(col.linkTo, v) : String(v);
  if (col.type === "currency") {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : fmt.money(n);
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
  if (col.type === "boolean") {
    return v === true || v === "true" || v === "yes" || v === 1 ? "Yes" : "No";
  }
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
  onAction?: (rec: RecordRow, set: Record<string, unknown>) => void;
  busyRecordId?: string | null;
}

/**
 * The row as an expression sees it: its fields plus its id, so a guard
 * or an action can refer to the row itself.
 */
function withId(rec: RecordRow): Record<string, unknown> {
  return { ...(rec.data ?? {}), id: rec.id };
}

/** A row action is offered only when its guard matches that row. */
function actionsFor(
  actions: FeatureSchema["actions"],
  rec: RecordRow
): NonNullable<FeatureSchema["actions"]> {
  return (actions ?? []).filter(
    (a) => a.when === undefined || truthy(evalExpr(a.when, withId(rec)))
  );
}

const ACTION_STYLES: Record<string, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  danger: "bg-rose-600 text-white hover:bg-rose-700",
  neutral: "border border-slate-200 text-slate-600 hover:bg-slate-50",
};

export function ActionButtons({
  rec,
  actions,
  onAction,
  busy,
}: {
  rec: RecordRow;
  actions: FeatureSchema["actions"];
  onAction?: (rec: RecordRow, set: Record<string, unknown>) => void;
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
            onAction(rec, resolved);
          }}
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
            ACTION_STYLES[a.style ?? "neutral"] ?? ACTION_STYLES.neutral
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────

export function TableView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  sort,
  onSort,
}: ViewProps & {
  sort: { field: string; dir: "asc" | "desc" } | null;
  onSort: (field: string) => void;
}) {
  const hasActions = (actions?.length ?? 0) > 0 && !!onAction;
  return (
    <div className="overflow-x-auto thin-scroll">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] tracking-wider text-slate-500 uppercase">
            {columns.map((col) => (
              <th
                key={col.field}
                onClick={() => onSort(col.field)}
                className="cursor-pointer px-4 py-2.5 font-semibold transition-colors select-none hover:text-slate-800"
                title="Click to sort"
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  <span className="text-slate-400">
                    {sort?.field === col.field ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                  </span>
                </span>
              </th>
            ))}
            {hasActions && <th className="px-4 py-2.5" />}
          </tr>
        </thead>
        <tbody>
          {records.map((rec) => (
            <tr
              key={rec.id}
              onClick={() => onOpen?.(rec)}
              className={`border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/40 ${
                onOpen ? "cursor-pointer" : ""
              }`}
            >
              {columns.map((col) => (
                <td key={col.field} className="px-4 py-2.5 align-middle">
                  <Cell col={col} value={rec.data?.[col.field]} />
                </td>
              ))}
              {hasActions && (
                <td className="px-4 py-2.5 text-right">
                  <ActionButtons
                    rec={rec}
                    actions={actions}
                    onAction={onAction}
                    busy={busyRecordId === rec.id}
                  />
                </td>
              )}
            </tr>
          ))}
          {records.length === 0 && (
            <tr>
              <td colSpan={columns.length + (hasActions ? 1 : 0)}>
                <EmptyState total={allRecordCount} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
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
  if (groups.length === 0) return <EmptyState total={allRecordCount} />;

  const cardFields = (view.cardFields ?? [])
    .map((f) => columns.find((c) => c.field === f))
    .filter((c): c is SchemaColumn => !!c);

  return (
    <div className="flex gap-3 overflow-x-auto p-3 thin-scroll">
      {groups.map((g) => {
        const rows = records.filter(
          (r) => (String(r.data?.[view.groupBy] ?? "").trim() || "Unassigned") === g
        );
        return (
          <div key={g} className="flex w-[72vw] max-w-64 shrink-0 flex-col rounded-xl bg-slate-50 p-2 sm:w-64">
            <div className="flex items-center justify-between px-1.5 pb-2">
              <Badge value={g} dot />
              <span className="text-[11px] font-medium text-slate-400 tabular-nums">
                {rows.length}
              </span>
            </div>
            <div className="space-y-2">
              {rows.map((rec) => (
                <div
                  key={rec.id}
                  onClick={() => onOpen?.(rec)}
                  className={`rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md ${
                    onOpen ? "cursor-pointer" : ""
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-800">
                    {fieldText(fmt, columns, rec, view.cardTitle, linkLabel) || "Untitled"}
                  </div>
                  {cardFields.map((col) => {
                    const val = fieldText(fmt, columns, rec, col.field, linkLabel);
                    if (!val) return null;
                    return (
                      <div key={col.field} className="mt-1 flex gap-1.5 text-[11px] leading-snug">
                        <span className="shrink-0 text-slate-400">{col.label}</span>
                        <span className="min-w-0 truncate text-slate-600">{val}</span>
                      </div>
                    );
                  })}
                  <div className="mt-2 empty:mt-0">
                    <ActionButtons
                      rec={rec}
                      actions={actions}
                      onAction={onAction}
                      busy={busyRecordId === rec.id}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {groupCol === undefined && (
        <div className="self-center text-xs text-slate-400">
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
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "calendar" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  const dated = records
    .map((r) => ({ rec: r, raw: String(r.data?.[view.dateField] ?? "") }))
    .map((x) => ({ ...x, d: new Date(x.raw) }))
    .filter((x) => !Number.isNaN(x.d.getTime()));

  if (dated.length === 0) return <EmptyState total={allRecordCount} />;

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
        <div className="font-display text-sm font-semibold text-slate-800">
          {first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        {outside > 0 && (
          <div className="text-[11px] text-slate-400">
            {outside} more in other months
          </div>
        )}
      </div>
      <div className="grid min-w-[560px] grid-cols-7 gap-px overflow-hidden rounded-lg bg-slate-200">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-slate-50 px-2 py-1.5 text-center text-[10px] font-semibold tracking-wider text-slate-500 uppercase"
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          const entries = day ? (byDay.get(day) ?? []) : [];
          return (
            <div
              key={i}
              className={`min-h-[84px] bg-white p-1.5 ${day === null ? "bg-slate-50/60" : ""}`}
            >
              {day !== null && (
                <>
                  <div className="mb-1 text-[11px] font-medium text-slate-400 tabular-nums">
                    {day}
                  </div>
                  <div className="space-y-1">
                    {entries.slice(0, 3).map(({ rec }) => {
                      const colour = view.colorBy
                        ? badgeColorFor(String(rec.data?.[view.colorBy] ?? ""))
                        : "bg-blue-100 text-blue-800 ring-blue-200";
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
                      <div className="px-1 text-[10px] text-slate-400">
                        +{entries.length - 3} more
                      </div>
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
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "cards" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (records.length === 0) return <EmptyState total={allRecordCount} />;
  const extra = (view.fields ?? [])
    .map((f) => columns.find((c) => c.field === f))
    .filter((c): c is SchemaColumn => !!c);

  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {records.map((rec) => (
        <div
          key={rec.id}
          onClick={() => onOpen?.(rec)}
          className={`rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-shadow hover:shadow-md ${
            onOpen ? "cursor-pointer" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-800">
                {fieldText(fmt, columns, rec, view.titleField, linkLabel) || "Untitled"}
              </div>
              {view.subtitleField && (
                <div className="truncate text-xs text-slate-500">
                  {fieldText(fmt, columns, rec, view.subtitleField, linkLabel)}
                </div>
              )}
            </div>
            {view.badgeField && rec.data?.[view.badgeField] != null && (
              <Badge value={String(rec.data[view.badgeField])} />
            )}
          </div>
          {extra.length > 0 && (
            <dl className="mt-2.5 space-y-1 border-t border-slate-100 pt-2.5">
              {extra.map((col) => {
                const val = fieldText(fmt, columns, rec, col.field, linkLabel);
                if (!val) return null;
                return (
                  <div key={col.field} className="flex justify-between gap-2 text-[11px]">
                    <dt className="text-slate-400">{col.label}</dt>
                    <dd className="truncate font-medium text-slate-700">{val}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          <div className="mt-2.5 empty:mt-0">
            <ActionButtons
              rec={rec}
              actions={actions}
              onAction={onAction}
              busy={busyRecordId === rec.id}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── List ─────────────────────────────────────────────────────

export function ListView({
  columns,
  records,
  allRecordCount,
  onOpen,
  actions,
  onAction,
  busyRecordId,
  view,
}: ViewProps & { view: Extract<ViewSpec, { type: "list" }> }) {
  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  if (records.length === 0) return <EmptyState total={allRecordCount} />;
  return (
    <ul className="divide-y divide-slate-100">
      {records.map((rec) => (
        <li
          key={rec.id}
          onClick={() => onOpen?.(rec)}
          className={`flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50/70 ${
            onOpen ? "cursor-pointer" : ""
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-slate-800">
              {fieldText(fmt, columns, rec, view.titleField, linkLabel) || "Untitled"}
            </div>
            {view.secondaryField && (
              <div className="truncate text-[11px] text-slate-500">
                {fieldText(fmt, columns, rec, view.secondaryField, linkLabel)}
              </div>
            )}
          </div>
          {view.metaField && (
            <div className="shrink-0 text-[11px] text-slate-500 tabular-nums">
              {fieldText(fmt, columns, rec, view.metaField, linkLabel)}
            </div>
          )}
          {view.badgeField && rec.data?.[view.badgeField] != null && (
            <Badge value={String(rec.data[view.badgeField])} />
          )}
          <ActionButtons
            rec={rec}
            actions={actions}
            onAction={onAction}
            busy={busyRecordId === rec.id}
          />
        </li>
      ))}
    </ul>
  );
}

// ── Shared ───────────────────────────────────────────────────

export function EmptyState({ total }: { total: number }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="text-sm text-slate-500">
        {total === 0 ? "Nothing here yet." : "Nothing matches the current search or filters."}
      </div>
    </div>
  );
}
