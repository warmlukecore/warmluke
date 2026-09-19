"use client";

// ─────────────────────────────────────────────────────────────
// GenericRenderer — the ONE renderer used for every module and for
// AI change previews. It owns the parts every view shares (search,
// filters, stat cards, sorting) and then hands the rows to whichever
// view the assistant chose for this module. Zero references to any
// specific module or field: everything comes from schema_json.
// ─────────────────────────────────────────────────────────────

import { filterOptions, matchesFilter } from "@/lib/filters";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { useEffect, useMemo, useState } from "react";
import type { FeatureSchema, RecordRow, UiSchema, ViewSpec } from "@/lib/types";

type StatSpec = NonNullable<FeatureSchema["stats"]>[number];
/** What the server is asked: the cards as designed, and what the person is looking at. */
export type StatRequest = {
  stats: StatSpec[];
  scope: {
    search: string;
    search_fields: string[];
    filters: Record<string, string>;
    computed: Array<{ field: string; expr: unknown }>;
    currency_fields: string[];
  };
};
/** One per stat: counted, not formatted. */
export type StatResult = {
  count: number;
  value: number | null;
  currencies: string[];
  groups?: Array<{ key: string; value: number | null; count: number }>;
};
type StatCard = { label: string; display: string; groups?: Array<{ key: string; display: string }> };
import RecordModal from "@/components/RecordModal";
import ScanBar from "@/components/ScanBar";
import {
  BoardView,
  CalendarView,
  CardsView,
  EmptyState,
  ListView,
  TableView,
  compare,
} from "@/components/views";
import { useFormat } from "@/lib/format";
import { evalExpr, truthy, withComputed } from "@/lib/expr";

const VIEW_LABELS: Record<ViewSpec["type"], string> = {
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  cards: "Cards",
  list: "List",
};

export default function GenericRenderer({
  schema,
  records,
  totalRecords,
  onLoadMore,
  preview = false,
  onCreate,
  onUpdate,
  onDelete,
  onStats,
}: {
  schema: UiSchema;
  records: RecordRow[];
  /** Rows that exist, which may exceed the page that's loaded. */
  totalRecords?: number;
  /** Absent once everything is loaded. */
  onLoadMore?: () => Promise<void>;
  preview?: boolean;
  /** Omitted in previews, which are read-only by design. */
  onCreate?: (data: Record<string, unknown>) => Promise<void>;
  onUpdate?: (recordId: string, data: Record<string, unknown>) => Promise<void>;
  onDelete?: (recordId: string) => Promise<void>;
  /**
   * Counts the stat cards on the server, over every row of the section
   * rather than the page that loaded. Absent in previews, which have
   * only the rows they were handed.
   */
  onStats?: (req: StatRequest) => Promise<StatResult[]>;
}) {
  const fmt = useFormat();
  const total = totalRecords ?? records.length;
  const [loadingMore, setLoadingMore] = useState(false);
  const editable = !preview && !!onCreate && !!onUpdate && !!onDelete;
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const columns = useMemo(() => schema?.columns ?? [], [schema]);
  const features: FeatureSchema | null =
    (schema as UiSchema & { features?: FeatureSchema | null })?.features ?? null;

  const [search, setSearch] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);

  const effectiveSort = sort ?? features?.defaultSort ?? null;
  const view: ViewSpec = features?.view ?? { type: "table" };

  // Computed columns are filled in once, up front, so that everything
  // below — the search box, the filters, the sort, the stats and every
  // view — reads them as ordinary fields.
  const rowsWithComputed = useMemo(
    () =>
      columns.some((c) => c.compute)
        ? records.map((r) => ({ ...r, data: withComputed(columns, r.data ?? {}) }))
        : records,
    [records, columns]
  );

  const filteredRecords = useMemo(() => {
    let rows = rowsWithComputed;

    if (features?.search?.enabled && search.trim()) {
      const q = search.trim().toLowerCase();
      const fields =
        features.search.fields?.filter((f) => columns.some((c) => c.field === f)) ??
        columns.map((c) => c.field);
      rows = rows.filter((r) =>
        fields.some((f) => String(r.data?.[f] ?? "").toLowerCase().includes(q))
      );
    }

    for (const fl of features?.filters ?? []) {
      const v = filterValues[fl.field];
      // Compared the way the search box beside it compares: a
      // dropdown that matched byte for byte offered "active" against
      // Shopify's "ACTIVE" and found nothing, twenty-one times.
      if (v) rows = rows.filter((r) => matchesFilter(r, fl.field, v));
    }

    if (effectiveSort && columns.some((c) => c.field === effectiveSort.field)) {
      const col = columns.find((c) => c.field === effectiveSort.field)!;
      rows = [...rows].sort((a, b) =>
        effectiveSort.dir === "asc"
          ? compare(a.data?.[effectiveSort.field], b.data?.[effectiveSort.field], col.type)
          : compare(b.data?.[effectiveSort.field], a.data?.[effectiveSort.field], col.type)
      );
    }

    return rows;
  }, [rowsWithComputed, columns, features, search, filterValues, effectiveSort]);

  const rowCurrencyFields = useMemo(
    () => [
      ...new Set(
        columns
          .filter((c) => c.type === "currency" && c.currencyField)
          .map((c) => c.currencyField as string)
      ),
    ],
    [columns]
  );

  // A stat card from a result, whichever side counted it.
  const cardFrom = (s: StatSpec, r: StatResult): StatCard => {
    const shown = (val: number | null, currencies: string[]) =>
      s.format === "currency"
        ? currencies.length > 1
          ? "Mixed currencies"
          : fmt.money(val ?? 0, currencies[0] ?? null)
        : fmt.number(Math.round(val ?? 0));
    if (s.by) {
      return {
        label: s.label,
        display: "",
        groups: (r.groups ?? []).map((g) => ({
          key: g.key || "(blank)",
          display: s.op === "count" ? fmt.number(g.count) : shown(g.value, r.currencies),
        })),
      };
    }
    return {
      label: s.label,
      display: s.op === "count" ? fmt.number(r.count) : shown(r.value, r.currencies),
    };
  };

  // The browser's own count, over the rows it has. What every section
  // used to show; now only previews, which have nothing else.
  const localResult = (s: StatSpec, rows: RecordRow[]): StatResult => {
    const matched =
      s.where !== undefined ? rows.filter((r) => truthy(evalExpr(s.where, r.data ?? {}))) : rows;
    const expr = s.value ?? (s.field ? { field: s.field } : null);
    const agg = (rs: RecordRow[]): number | null => {
      if (s.op === "count") return rs.length;
      const nums = rs
        .map((r) => Number(expr ? evalExpr(expr, r.data ?? {}) : 0))
        .filter((n) => !Number.isNaN(n));
      if (nums.length === 0) return s.op === "sum" ? 0 : null;
      const total = nums.reduce((a, b) => a + b, 0);
      return s.op === "sum"
        ? total
        : s.op === "avg"
          ? total / nums.length
          : s.op === "min"
            ? Math.min(...nums)
            : Math.max(...nums);
    };
    const currencies = [
      ...new Set(
        matched.flatMap((r) =>
          rowCurrencyFields
            .map((f) => r.data?.[f])
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        )
      ),
    ];
    if (!s.by) return { count: matched.length, value: agg(matched), currencies };
    const buckets = new Map<string, RecordRow[]>();
    for (const r of matched) {
      const k = String(r.data?.[s.by] ?? "").trim();
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    }
    const groups = [...buckets]
      .map(([key, rs]) => ({ key, value: agg(rs), count: rs.length }))
      .sort(
        (a, b) =>
          (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.count - a.count || a.key.localeCompare(b.key)
      )
      .slice(0, Math.min(Math.max(s.limit ?? 5, 1), 20));
    return { count: matched.length, value: null, currencies, groups };
  };

  // Asked of the server whenever what the person is looking at changes,
  // a beat after they stop typing.
  const [serverStats, setServerStats] = useState<StatResult[] | null>(null);
  const statsKey = JSON.stringify(features?.stats ?? null);
  useEffect(() => {
    if (!onStats || !features?.stats?.length) {
      setServerStats(null);
      return;
    }
    let live = true;
    const searchFields = features.search?.enabled
      ? (features.search.fields?.filter((f) => columns.some((c) => c.field === f)) ??
        columns.map((c) => c.field))
      : [];
    const t = setTimeout(() => {
      onStats({
        stats: features.stats!,
        scope: {
          search: features.search?.enabled ? search.trim() : "",
          search_fields: searchFields,
          filters: filterValues,
          computed: columns.filter((c) => c.compute).map((c) => ({ field: c.field, expr: c.compute })),
          currency_fields: rowCurrencyFields,
        },
      })
        .then((r) => {
          if (live) setServerStats(r);
        })
        .catch(() => {
          if (live) setServerStats(null);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // records: a row added or changed is a number that moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStats, statsKey, search, filterValues, columns, records, rowCurrencyFields]);

  const stats: StatCard[] = useMemo(() => {
    if (!features?.stats?.length) return [];
    if (onStats) {
      return serverStats
        ? features.stats.map((s, i) => cardFrom(s, serverStats[i] ?? { count: 0, value: null, currencies: [] }))
        : features.stats.map((s) => ({ label: s.label, display: "…" }));
    }
    return features.stats.map((s) => cardFrom(s, localResult(s, filteredRecords)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, filteredRecords, fmt, onStats, serverStats, rowCurrencyFields]);

  if (columns.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        This section has no columns defined yet.
      </div>
    );
  }

  async function runWrite(fn: () => Promise<void>, recordId?: string) {
    setWriteError(null);
    setSaving(true);
    if (recordId) setBusyRecordId(recordId);
    try {
      await fn();
      setEditing(null);
      setAdding(false);
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setSaving(false);
      setBusyRecordId(null);
    }
  }

  const viewProps = {
    columns,
    records: filteredRecords,
    allRecordCount: records.length,
    onOpen: editable ? (rec: RecordRow) => setEditing(rec) : undefined,
    actions: features?.actions,
    onAction: editable
      ? (rec: RecordRow, set: Record<string, unknown>) =>
          runWrite(() => onUpdate!(rec.id, set), rec.id)
      : undefined,
    busyRecordId,
  };

  function renderView() {
    switch (view.type) {
      case "board":
        return <BoardView {...viewProps} view={view} />;
      case "calendar":
        return <CalendarView {...viewProps} view={view} />;
      case "cards":
        return <CardsView {...viewProps} view={view} />;
      case "list":
        return <ListView {...viewProps} view={view} />;
      case "table":
      default:
        return (
          <TableView
            {...viewProps}
            sort={effectiveSort}
            onSort={(field) =>
              setSort((prev) =>
                prev?.field === field
                  ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
                  : { field, dir: "asc" }
              )
            }
          />
        );
    }
  }

  return (
    <div className="space-y-4">
      {editable && features?.scanMode && (
        <ScanBar
          scanMode={features.scanMode}
          // Scans match what is in view, not the whole section. A packer
          // filters to the order in front of them; matching every row
          // meant a barcode belonging to a DIFFERENT order silently
          // matched and updated that one, which is worse than no check.
          records={filteredRecords}
          onApply={(rec, set) => onUpdate!(rec.id, set)}
          onCreate={onCreate}
        />
      )}

      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                {s.label}
              </div>
              {s.groups ? (
                <div className="mt-1.5 space-y-0.5">
                  {s.groups.length === 0 ? (
                    <div className="text-sm text-slate-400">—</div>
                  ) : (
                    s.groups.map((g) => (
                      <div key={g.key} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate text-slate-700">{g.key}</span>
                        <span className="font-display font-semibold text-slate-900 tabular-nums">
                          {g.display}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="font-display mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
                  {s.display}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {preview && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="font-display -rotate-12 text-6xl font-black tracking-widest text-slate-900/5 select-none">
              PREVIEW
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3.5 py-2.5">
            {features?.search?.enabled && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={features.search.placeholder ?? "Search…"}
                className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:w-52"
              />
            )}
            {(features?.filters ?? []).map((fl) => (
              <select
                key={fl.field}
                value={filterValues[fl.field] ?? ""}
                onChange={(e) =>
                  setFilterValues((prev) => ({ ...prev, [fl.field]: e.target.value }))
                }
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 outline-none transition-colors focus:border-blue-400"
              >
                <option value="">{fl.label}: All</option>
                {filterOptions(fl.options ?? [], rowsWithComputed, fl.field).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ))}
            <span className="ml-auto hidden rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase sm:inline">
              {VIEW_LABELS[view.type]}
            </span>
            {editable && (
              <button
                onClick={() => setAdding(true)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-slate-700"
              >
                + Add
              </button>
            )}
          </div>

        {writeError && (
          <div className="border-b border-rose-100 px-4 py-2">
            <ErrorNote error={asError(writeError, "That didn't save.")} compact onDismiss={() => setWriteError(null)} />
          </div>
        )}

        {records.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-sm text-slate-500">Nothing here yet.</div>
            {editable && (
              <button
                onClick={() => setAdding(true)}
                className="mt-3 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-700"
              >
                Add the first one
              </button>
            )}
          </div>
        ) : (
          renderView()
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>
            {filteredRecords.length} of {records.length} record{records.length === 1 ? "" : "s"}
            {total > records.length && ` shown · ${total} in total`}
            {preview && " · not saved yet"}
          </span>
          {onLoadMore && (
            <button
              onClick={async () => {
                setLoadingMore(true);
                try {
                  await onLoadMore();
                } finally {
                  setLoadingMore(false);
                }
              }}
              disabled={loadingMore}
              className="ml-auto rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
        {total > records.length && (
          <div className="border-t border-amber-100 bg-amber-50/70 px-4 py-1.5 text-[10px] text-amber-800">
            {onStats
              ? `The totals above cover all ${fmt.number(total)} rows; the list below is the ${records.length} loaded so far.`
              : `Search, filters and the totals above cover the ${records.length} rows loaded so far.`}
          </div>
        )}
      </div>

      {(adding || editing) && editable && (
        <RecordModal
          schema={schema}
          records={records}
          record={editing}
          busy={saving}
          onSave={(data) =>
            runWrite(() =>
              editing ? onUpdate!(editing.id, data) : onCreate!(data),
              editing?.id
            )
          }
          onDelete={() => runWrite(() => onDelete!(editing!.id), editing?.id)}
          onClose={() => {
            setEditing(null);
            setAdding(false);
            setWriteError(null);
          }}
        />
      )}
    </div>
  );
}
