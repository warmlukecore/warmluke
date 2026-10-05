"use client";

// ─────────────────────────────────────────────────────────────
// GenericRenderer — the ONE renderer used for every module and for
// AI change previews. It owns the parts every view shares (search,
// filters, stat cards, sorting) and then hands the rows to whichever
// view the assistant chose for this module. Zero references to any
// specific module or field: everything comes from schema_json.
// ─────────────────────────────────────────────────────────────

import { filterOptions, matchesFilter } from "@/lib/filters";
import { filterIsOff } from "@/lib/view-edit";
import type { ScreenAsk } from "@/lib/screen";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
    /** The dates picked above the section (0161), as abo_in_period reads them. */
    period?: { field: string; from_day: string; to_day: string; from: string; to: string } | null;
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
import CustomView from "@/components/CustomView";
import {
  Badge,
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
import { sameCode } from "@/lib/scan";
import { PREVIEW_ROWS } from "@/lib/change-preview";
import { badgeLabel } from "@/lib/tone";
import { button, fieldOf, iconButtonRound, menu, menuItem } from "@/components/ui/controls";
import { DateRange } from "@/components/ui/DateRange";
import { Tabs } from "@/components/ui/Tabs";
import { VIEW_NAMES, sectionTabs, tabName } from "@/lib/tabs";
import {
  inPeriod,
  keptPick,
  openingPick,
  periodRange,
  pickLabel,
  presetsOf,
  todayIn,
  weekStartOf,
  type PeriodPick,
  type PeriodRange,
  type PeriodSpec,
} from "@/lib/period";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { PAGE_SIZES, keptPageSize, pageSizeKey, type TableState } from "@/lib/store-read";

/** A table shows this many rows at a time; the rest are a page away. */
const PAGE = 50;

/**
 * One filter, as the app's own listbox rather than the system's select
 * menu: the choices in the app's type, a status as the badge it is, and
 * arrows, Home, End, Enter and Escape as a list box answers them.
 */
function FilterMenu({
  label,
  options,
  value,
  badges,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  /** The field holds statuses: each choice is drawn as its badge. */
  badges: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Opens towards the space there is: from the right edge when the left would run off the window.
  const [fromRight, setFromRight] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const all = ["", ...options];

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    const at = trigger.current?.getBoundingClientRect();
    setFromRight(!!at && at.left + 208 > window.innerWidth - 8);
    setActive(Math.max(0, all.indexOf(value)));
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(all[i]);
    setOpen(false);
    trigger.current?.focus();
  };
  const keys = (e: React.KeyboardEvent) => {
    const last = all.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Filter by ${label}${value ? `: ${badges ? badgeLabel(value) : value}` : ""}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
        className={button("secondary", "sm")}
      >
        <span className={value ? "text-fg-muted" : ""}>{label}</span>
        {value && <span className="max-w-40 truncate">{badges ? badgeLabel(value) : value}</span>}
        <ChevronDown
          aria-hidden
          size={13}
          strokeWidth={2}
          className={`text-fg-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className={`${menu} absolute top-full mt-1 w-52 ${fromRight ? "right-0" : "left-0"}`}>
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={`${id}-${active}`}
            onKeyDown={keys}
            className="max-h-64 overflow-y-auto outline-none thin-scroll"
          >
            {all.map((o, i) => (
              <li
                key={o || "all"}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o === value}
                onClick={() => choose(i)}
                onMouseEnter={() => setActive(i)}
                className={`${menuItem} cursor-pointer ${i === active ? "bg-surface-hover" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {!o ? `Any ${label.toLowerCase()}` : badges ? <Badge value={o} /> : o}
                </span>
                {o === value && <Check aria-hidden size={14} strokeWidth={2} className="shrink-0 text-fg-muted" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The dates a section is read over (features.period): one button saying
 * which, opening shortcuts and a calendar (ui/DateRange). The pick
 * narrows the rows, the stat cards and the view together; said in words
 * for a screen reader as it changes.
 */
function PeriodBar({
  spec,
  label,
  pick,
  shown,
  today,
  locale,
  onPick,
}: {
  spec: PeriodSpec;
  label: string;
  pick: PeriodPick;
  shown: PeriodRange | null;
  today: string;
  locale: string;
  onPick: (pick: PeriodPick) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRange
        label={label}
        pick={pick}
        shown={shown}
        today={today}
        presets={presetsOf(spec)}
        locale={locale}
        weekStart={weekStartOf(locale)}
        onPick={onPick}
      />
      <span role="status" className="sr-only">
        {`${label}: ${pickLabel(pick)}`}
      </span>
    </div>
  );
}

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
  onInspect,
  onScanGroup,
  onScreenBroke,
  onScreenFix,
  onReadSection,
  periodKey,
  timeZone,
  onPeriod,
  serverRows,
  ask,
  onApprovalButton,
  waitsForOwner = false,
}: {
  schema: UiSchema;
  records: RecordRow[];
  /** Rows that exist, which may exceed the page that's loaded. */
  totalRecords?: number;
  /** Absent once everything is loaded. */
  onLoadMore?: () => Promise<void>;
  /**
   * A section over the store reads a page at a time from the whole list
   * (0167). Given, the search, the filters, the sort and the page are
   * the server's: this says what the table shows, and `records` is that
   * page, `totalRecords` everything that matches.
   */
  serverRows?: {
    onChange: (state: TableState) => void;
    /** What each filter can offer, from the whole list. */
    facets: Record<string, string[]>;
    /** Where the search looks when the section names no fields. */
    searchFields: string[];
    moduleId: string;
  };
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
  /**
   * Opens a row that cannot be edited here — a store row, owned by the
   * import. Without it such a row did nothing when tapped, and an order
   * is exactly the thing a merchant taps to see what was in it.
   */
  onInspect?: (rec: RecordRow) => void;
  /** Reads the rows whose field holds a code into the section, wherever they are, and hands them back (a scan's group, a written screen's wl.find). */
  onScanGroup?: (field: string, code: string) => Promise<RecordRow[]>;
  /** A written screen broke while it ran: kept, so it is seen (Needs a look). */
  onScreenBroke?: (screen: string, message: string) => void;
  /** Hands what broke in a written screen to Luke, to fix it. */
  onScreenFix?: (screen: string, messages: string[]) => void;
  /** Another section of this app, read only: what a written screen reads beyond its own rows. */
  onReadSection?: (
    section: string,
    match?: { field: string; code: string }
  ) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  /** Which section this is, so the dates picked above it are its own and remembered on this device. */
  periodKey?: string;
  /** Whose days "the last N days" are: the shop's zone on a section over the store; this device's otherwise. */
  timeZone?: string;
  /** Told the dates picked, so the page can read the rows inside them rather than only the page it holds. */
  onPeriod?: (range: PeriodRange | null) => void;
  /** Asked of this screen by Luke, or by a link from their own AI (lib/screen.ts): done once each time `at` changes. */
  ask?: (ScreenAsk & { at: number }) | null;
  /** Presses a button that needs the owner's yes (0183): the server works it out, and waits or does it. */
  onApprovalButton?: (rec: RecordRow, label: string) => Promise<void>;
  /** This person is not the owner: such a button's press waits for the owner. */
  waitsForOwner?: boolean;
}) {
  const fmt = useFormat();
  const total = totalRecords ?? records.length;
  const [loadingMore, setLoadingMore] = useState(false);
  const editable = !preview && !!onCreate && !!onUpdate && !!onDelete;
  // Fields may be set without rows being added or removed: a section
  // over the store's orders, where the merchant's own fields sit beside
  // each order (0128). Row actions and scans set fields, so they need
  // only this; adding and removing rows needs the rest.
  const canSet = !preview && !!onUpdate;
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const columns = useMemo(() => schema?.columns ?? [], [schema]);
  // A yes/no column filters as a tick: Yes, or every row not ticked.
  const yesNo = (f: string) => columns.some((c) => c.field === f && c.type === "boolean");
  const features: FeatureSchema | null = (schema as UiSchema & { features?: FeatureSchema | null })?.features ?? null;
  // On the bar: one taken off it with Customize keeps its choices for the row form (lib/view-edit).
  const barFilters = (features?.filters ?? []).filter((f) => !filterIsOff(f));

  const [search, setSearch] = useState("");
  // The group a scan opened (scanMode.first): while it is open the
  // section shows its rows alone, and the scan bar matches only them.
  const [scanGroup, setScanGroup] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  // The table's page, over the rows loaded; back to the first whenever what is shown changes.
  const [page, setPage] = useState(0);
  // Over the store, the page is the server's (0167): how many a page,
  // kept on this device per section, and the search asked once typing pauses.
  const server = !!serverRows && !preview;
  const sizeFor = serverRows?.moduleId ?? "";
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const chosenSize = sizeFor ? (sizes[sizeFor] ?? keptPageSize(sizeFor)) : PAGE;
  const chooseSize = (n: number) => {
    setSizes((p) => ({ ...p, [sizeFor]: n }));
    setPage(0);
    try {
      localStorage.setItem(pageSizeKey(sizeFor), String(n));
    } catch {
      // Not kept; it holds until the page is left.
    }
  };
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const effectiveSort = sort ?? features?.defaultSort ?? null;

  // Its views as tabs (features.tabs), its own first: the one open is
  // remembered per section on this device, and a tab since taken away
  // opens the first. One section's open tab is not another's.
  const views = sectionTabs(features);
  const tabMemory = periodKey ? `abo_tab:${periodKey}` : "";
  const [tabBy, setTabBy] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!tabMemory || tabMemory in tabBy) return;
    let kept: number | null = null;
    try {
      kept = Number(localStorage.getItem(tabMemory));
    } catch {
      // Storage refused: the first tab.
    }
    if (kept && Number.isInteger(kept)) setTabBy((t) => ({ ...t, [tabMemory]: kept }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabMemory]);
  const openTab = Math.min(Math.max(tabBy[tabMemory] ?? 0, 0), views.length - 1);
  const view: ViewSpec = views[openTab];
  // A screen Luke wrote reads the rows it is handed (wl.onRows): the
  // largest page there is, not the table's fifty.
  const size = view.type === "custom" ? PAGE_SIZES[PAGE_SIZES.length - 1] : chosenSize;

  // Over the store, what the table shows goes to the server whenever it changes.
  const tableKey = server ? JSON.stringify([page, size, asked, filterValues, sort]) : "";
  useEffect(() => {
    if (server) serverRows!.onChange({ page, size, search: asked, filters: filterValues, sort });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);
  const chooseTab = (i: number) => {
    setTabBy((t) => ({ ...t, [tabMemory]: i }));
    setPage(0);
    if (!tabMemory) return;
    try {
      localStorage.setItem(tabMemory, String(i));
    } catch {
      // Not kept; it stays open until the page is left.
    }
  };

  // The dates picked above the section (features.period): one pick a
  // section, opening on its default, then on what this device last chose.
  const periodSpec: PeriodSpec | null = features?.period ?? null;
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const memory = periodKey ? `abo_period:${periodKey}` : "";
  const [picks, setPicks] = useState<Record<string, PeriodPick>>({});
  useEffect(() => {
    if (!memory || !periodSpec || memory in picks) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(memory);
    } catch {
      // Storage refused (a private window): the section's default it is.
    }
    const kept = keptPick(raw, periodSpec);
    if (kept !== undefined) setPicks((p) => ({ ...p, [memory]: kept }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory, periodSpec]);
  const pick: PeriodPick = !periodSpec ? null : memory in picks ? picks[memory] : openingPick(periodSpec);
  const pickKey = JSON.stringify(pick);
  const range = useMemo(
    () => (periodSpec ? periodRange(periodSpec.field, pick, zone, new Date(), weekStartOf(fmt.locale)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [periodSpec?.field, pickKey, zone]
  );
  const rangeKey = range ? `${range.field}|${range.from}|${range.to}` : "";
  const choosePick = (next: PeriodPick) => {
    setPicks((p) => ({ ...p, [memory]: next }));
    setPage(0);
    if (!memory) return;
    try {
      localStorage.setItem(memory, JSON.stringify(next ?? "all"));
    } catch {
      // Not kept; it still applies until the page is left.
    }
  };
  useEffect(() => {
    onPeriod?.(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // What Luke, or a link from their own AI, asked of this screen (lib/screen.ts),
  // set as they would set the bar themselves. A view is the whole view: what
  // it leaves out is cleared. A row to put in opens the form filled, for their Save.
  const [filled, setFilled] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!ask) return;
    if (ask.search !== undefined || ask.filters || ask.sort || ask.period !== undefined) {
      setSearch(ask.search ?? "");
      setFilterValues(ask.filters ?? {});
      setSort(ask.sort ?? null);
      setScanGroup(null);
      setPage(0);
      if (ask.period !== undefined && periodSpec) choosePick(ask.period);
    }
    if (ask.add && editable) {
      setEditing(null);
      setFilled(ask.add);
      setAdding(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.at]);

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
    // The page already reads the rows inside the dates; these are the
    // ones it held from before, or a preview's, which has nothing else.
    if (range) rows = rows.filter((r) => inPeriod(r.data?.[range.field], range));
    const opens = features?.scanMode?.first?.field;
    if (opens && scanGroup) rows = rows.filter((r) => sameCode(r.data?.[opens], scanGroup));

    // Over the store the server searched, filtered and sorted the whole
    // list (0167); a computed column, worked out here, is the page's own.
    const computedOnly = (f: string) => !server || columns.some((c) => c.field === f && c.compute);
    if (!server && features?.search?.enabled && search.trim()) {
      const q = search.trim().toLowerCase();
      const fields =
        features.search.fields?.filter((f) => columns.some((c) => c.field === f)) ?? columns.map((c) => c.field);
      // A phone typed any way finds it: "98765 43210" and "+91 98765-43210" are one number.
      const digits = q.replace(/\D/g, "");
      rows = rows.filter((r) =>
        fields.some((f) => {
          const v = String(r.data?.[f] ?? "");
          return v.toLowerCase().includes(q) || (digits.length >= 6 && v.replace(/\D/g, "").includes(digits));
        })
      );
    }

    for (const fl of features?.filters ?? []) {
      if (!computedOnly(fl.field)) continue;
      const v = filterValues[fl.field];
      // Compared the way the search box beside it compares: a
      // dropdown that matched byte for byte offered "active" against
      // Shopify's "ACTIVE" and found nothing, twenty-one times.
      if (v) rows = rows.filter((r) => matchesFilter(r, fl.field, v, yesNo(fl.field)));
    }

    if (effectiveSort && columns.some((c) => c.field === effectiveSort.field) && computedOnly(effectiveSort.field)) {
      const col = columns.find((c) => c.field === effectiveSort.field)!;
      rows = [...rows].sort((a, b) =>
        effectiveSort.dir === "asc"
          ? compare(a.data?.[effectiveSort.field], b.data?.[effectiveSort.field], col.type)
          : compare(b.data?.[effectiveSort.field], a.data?.[effectiveSort.field], col.type)
      );
    }

    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsWithComputed, columns, features, search, filterValues, effectiveSort, scanGroup, rangeKey, server]);

  const rowCurrencyFields = useMemo(
    () => [
      ...new Set(columns.filter((c) => c.type === "currency" && c.currencyField).map((c) => c.currencyField as string)),
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
    const matched = s.where !== undefined ? rows.filter((r) => truthy(evalExpr(s.where, r.data ?? {}))) : rows;
    const expr = s.value ?? (s.field ? { field: s.field } : null);
    const agg = (rs: RecordRow[]): number | null => {
      if (s.op === "count") return rs.length;
      const nums = rs.map((r) => Number(expr ? evalExpr(expr, r.data ?? {}) : 0)).filter((n) => !Number.isNaN(n));
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
          rowCurrencyFields.map((f) => r.data?.[f]).filter((v): v is string => typeof v === "string" && v.length > 0)
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
        (a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.count - a.count || a.key.localeCompare(b.key)
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
      ? (features.search.fields?.filter((f) => columns.some((c) => c.field === f)) ?? columns.map((c) => c.field))
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
          period: range
            ? { field: range.field, from_day: range.fromDay, to_day: range.toDay, from: range.from, to: range.to }
            : null,
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
  }, [onStats, statsKey, search, filterValues, columns, records, rowCurrencyFields, rangeKey]);

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
      <div className="flex h-40 items-center justify-center text-sm text-fg-muted">
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

  const custom = view.type === "custom";
  // What renderView draws as the table: its own type, and any it does not know.
  const table = !custom && !["board", "calendar", "cards", "list"].includes(view.type);
  // A section's table fills the page below its counters and scrolls within
  // it, so its head and its foot (the pages, the count) stay in view.
  const fill = table && !preview;
  const pages = server
    ? Math.max(1, Math.ceil(total / size))
    : fill
      ? Math.max(1, Math.ceil(filteredRecords.length / PAGE))
      : 1;
  const at = Math.min(page, pages - 1);
  const filtered = !!search.trim() || Object.values(filterValues).some(Boolean);
  // A list of the store's is searched always: 2,487 orders with no box to find one in is a list nobody can use.
  const searchable = server || !!features?.search?.enabled;
  const clearFilters = () => {
    setSearch("");
    setFilterValues({});
    setPage(0);
  };

  // A hidden column is the row's, when it is opened, not the view's.
  const shown = columns.filter((c) => !c.hidden);
  const viewProps = {
    columns: shown,
    // A preview's list is a glimpse; its totals above still count every row.
    records: preview ? filteredRecords.slice(0, PREVIEW_ROWS) : filteredRecords,
    onClearFilters: filtered ? clearFilters : undefined,
    allRecordCount: records.length,
    onOpen: editable ? (rec: RecordRow) => setEditing(rec) : preview ? undefined : onInspect,
    // A button that needs the owner's yes is the server's to work out and decide
    // (0183): pressed, it goes there; and a teammate sees that it will wait.
    actions: features?.actions?.map((a) => (a.approval && waitsForOwner ? { ...a, waits: true } : a)),
    onAction: canSet
      ? (rec: RecordRow, set: Record<string, unknown>, action?: { label: string; approval?: boolean }) =>
          action?.approval && onApprovalButton
            ? runWrite(() => onApprovalButton(rec, action.label), rec.id)
            : runWrite(() => onUpdate!(rec.id, set), rec.id)
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
      case "custom":
        return (
          <CustomView
            // Two written tabs are two screens, not one rewritten.
            key={openTab}
            view={view}
            columns={columns}
            records={filteredRecords}
            // Straight to the handlers: a refused write is the screen's to say, not a note above it.
            onSet={canSet ? (id, set) => onUpdate!(id, set) : undefined}
            onAdd={editable ? onCreate : undefined}
            onFind={preview ? undefined : onScanGroup}
            onRead={onReadSection}
            preview={preview}
            onBroke={preview || !onScreenBroke ? undefined : (message) => onScreenBroke(view.title, message)}
            onAskLuke={preview || !onScreenFix ? undefined : (messages) => onScreenFix(view.title, messages)}
          />
        );
      case "table":
      default:
        return (
          <TableView
            {...viewProps}
            // A new page, or another section's table, starts at its top left.
            key={`${at}:${shown.map((c) => c.field).join()}`}
            records={
              server ? filteredRecords : fill ? filteredRecords.slice(at * PAGE, (at + 1) * PAGE) : viewProps.records
            }
            sort={effectiveSort}
            onSort={(field) => {
              setPage(0);
              setSort((prev) =>
                prev?.field === field ? { field, dir: prev.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }
              );
            }}
          />
        );
    }
  }

  return (
    <div className={`flex flex-col gap-4 ${fill ? "min-h-0 flex-1" : ""}`}>
      {preview && (
        // A preview says so in a bar of its own above what it shows, as a
        // browser frame would, rather than a word laid across the rows.
        <div className="flex items-center gap-2 rounded-card bg-surface-subdued px-3.5 py-2 text-xs shadow-card">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-info" />
          <span className="font-medium text-fg">Preview</span>
          <span className="truncate text-fg-muted">Nothing is built until you approve it</span>
        </div>
      )}
      {canSet && features?.scanMode && (
        <ScanBar
          scanMode={features.scanMode}
          columns={columns}
          // Scans match what is in view, not the whole section. A packer
          // filters to the order in front of them; matching every row
          // meant a barcode belonging to a DIFFERENT order silently
          // matched and updated that one, which is worse than no check.
          records={filteredRecords}
          onApply={(rec, set) => onUpdate!(rec.id, set)}
          onCreate={onCreate}
          group={scanGroup}
          onGroup={(g) => {
            setScanGroup(g);
            setPage(0);
          }}
          onOpenGroup={onScanGroup}
        />
      )}

      {periodSpec && (
        <PeriodBar
          spec={periodSpec}
          label={
            periodSpec.label?.trim() || columns.find((c) => c.field === periodSpec.field)?.label || periodSpec.field
          }
          pick={pick}
          shown={range}
          today={todayIn(zone)}
          locale={fmt.locale}
          onPick={choosePick}
        />
      )}

      {stats.length > 0 && (
        // As many as fit the space they are in: a preview in Luke's panel
        // is narrow however wide the window, and four there broke every word.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5 sm:gap-3">
          {stats.map((s, i) => (
            <div key={i} className="rounded-card bg-surface px-4 py-3 shadow-card">
              <div className="text-xs font-medium text-fg-muted">{s.label}</div>
              {s.groups ? (
                <div className="mt-1.5 space-y-0.5">
                  {s.groups.length === 0 ? (
                    <div className="text-sm text-fg-faint">—</div>
                  ) : (
                    s.groups.map((g) => (
                      <div key={g.key} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate text-fg">{g.key}</span>
                        <span className="font-display font-semibold text-fg tabular-nums">{g.display}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : s.display === "…" ? (
                // Still being counted: a bar where the figure will be, not a mark that reads as one.
                <div role="status" aria-label={`Counting ${s.label}`} className="skeleton mt-2.5 mb-1 h-5 w-20" />
              ) : (
                <div
                  className={`font-display mt-1 font-semibold text-fg tabular-nums ${
                    s.display.length > 9 ? "text-lg" : "text-2xl"
                  }`}
                >
                  {s.display}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {views.length > 1 && (
        <Tabs
          tabs={views.map((v, i) => ({ id: String(i), text: tabName(v) }))}
          value={String(openTab)}
          onChange={(id) => chooseTab(Number(id))}
          label="Views of this section"
          className="-mb-1 shrink-0 overflow-x-auto"
        />
      )}

      {/* A written screen is the section: it carries its own search and steps, so the list's are not drawn around it. */}
      <div
        className={
          custom
            ? "relative"
            : `relative overflow-clip rounded-card bg-surface shadow-card ${fill ? "flex min-h-0 flex-col" : ""}`
        }
      >
        {/* Only with something in it to use: a bar holding a lone "Table" said nothing. */}
        {!custom && (searchable || barFilters.length > 0 || editable) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
            {searchable && (
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder={features?.search?.placeholder ?? "Search…"}
                aria-label={features?.search?.placeholder ?? "Search"}
                className={`${fieldOf("md")} w-full min-w-0 sm:w-60`}
              />
            )}
            {barFilters.map((fl) => (
              <FilterMenu
                key={fl.field}
                label={fl.label}
                value={filterValues[fl.field] ?? ""}
                options={filterOptions(
                  fl.options ?? [],
                  server
                    ? [
                        ...rowsWithComputed,
                        ...(serverRows!.facets[fl.field] ?? []).map(
                          (v) => ({ id: "", data: { [fl.field]: v } }) as RecordRow
                        ),
                      ]
                    : rowsWithComputed,
                  fl.field,
                  yesNo(fl.field)
                )}
                badges={columns.find((c) => c.field === fl.field)?.type === "badge"}
                onChange={(v) => {
                  setFilterValues((prev) => ({ ...prev, [fl.field]: v }));
                  setPage(0);
                }}
              />
            ))}
            {views.length === 1 && (
              <span className="ml-auto hidden rounded-full bg-tone-neutral px-2 py-0.5 text-xs text-tone-neutral-fg sm:inline">
                {VIEW_NAMES[view.type]}
              </span>
            )}
            {editable && (
              <button
                onClick={() => setAdding(true)}
                className={`${button("primary", "sm")} ${views.length > 1 ? "ml-auto" : ""}`}
              >
                <Plus aria-hidden size={14} strokeWidth={2} />
                Add
              </button>
            )}
          </div>
        )}

        {writeError && (
          <div className="border-b border-tone-critical/70 px-4 py-2">
            <ErrorNote error={asError(writeError, "That didn't save.")} compact onDismiss={() => setWriteError(null)} />
          </div>
        )}

        {records.length === 0 && !custom ? (
          // Over the store an empty page with a search or filter on is
          // nothing matching, with the way back, not an empty list.
          <EmptyState
            total={server && filtered ? 1 : 0}
            onClear={server && filtered ? clearFilters : undefined}
            onAdd={editable ? () => setAdding(true) : undefined}
          />
        ) : (
          renderView()
        )}

        {!custom && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-1.5 text-xs text-fg-muted">
            {pages > 1 && (
              // The pages of what is loaded, as one pill: back, where, on.
              <div role="group" aria-label="Pages" className="flex items-center rounded-full bg-surface-subdued">
                <button
                  onClick={() => setPage(at - 1)}
                  disabled={at === 0}
                  aria-label="Previous page"
                  className={iconButtonRound}
                >
                  <ChevronLeft aria-hidden size={16} strokeWidth={1.75} />
                </button>
                <span className="px-1 font-medium text-fg tabular-nums">
                  {server
                    ? `${fmt.number(at * size + 1)}–${fmt.number(Math.min((at + 1) * size, total))}`
                    : `${fmt.number(at * PAGE + 1)}–${fmt.number(Math.min((at + 1) * PAGE, filteredRecords.length))}`}
                </span>
                <button
                  onClick={() => setPage(at + 1)}
                  disabled={at >= pages - 1}
                  aria-label="Next page"
                  className={iconButtonRound}
                >
                  <ChevronRight aria-hidden size={16} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {server ? (
              <>
                <span className="tabular-nums">
                  {/* With pages, the pill says where: this says of how many. */}
                  {total === 0
                    ? "None"
                    : pages > 1
                      ? `of ${fmt.number(total)}`
                      : `${fmt.number(at * size + 1)}–${fmt.number(Math.min((at + 1) * size, total))} of ${fmt.number(total)}`}
                </span>
                {/* How many a page: the browser holds a page, never the store. */}
                <div role="group" aria-label="Rows a page" className="ml-auto flex items-center gap-0.5">
                  {[...PAGE_SIZES]
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <button
                        key={n}
                        onClick={() => chooseSize(n)}
                        aria-pressed={size === n}
                        className={`rounded-control px-1.5 py-0.5 tabular-nums transition-colors ${
                          size === n ? "bg-surface-hover font-medium text-fg" : "hover:text-fg"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  <span className="ml-1 hidden sm:inline">a page</span>
                </div>
              </>
            ) : (
              <span className="tabular-nums">
                {preview ? Math.min(PREVIEW_ROWS, filteredRecords.length) : filteredRecords.length} of {records.length}{" "}
                record{records.length === 1 ? "" : "s"}
                {total > records.length && ` shown · ${total} in total`}
              </span>
            )}
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
                className={`${button("secondary", "sm")} ml-auto`}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
        {total > records.length && !custom && !server && (
          <div className="shrink-0 border-t border-tone-attention/70 bg-tone-attention/25 px-3 py-1.5 text-[11px] text-tone-attention-fg">
            {onStats
              ? `The totals above cover all ${fmt.number(total)} rows; the list below is the ${records.length} loaded so far.`
              : `Search, filters and the totals above cover the ${records.length} rows loaded so far.`}
          </div>
        )}
      </div>

      {(adding || editing) && editable && (
        <RecordModal
          // A row filled in again while the form is open starts the form again.
          key={editing ? editing.id : filled ? JSON.stringify(filled) : "new"}
          schema={schema}
          records={records}
          record={editing}
          busy={saving}
          onSave={(data) => runWrite(() => (editing ? onUpdate!(editing.id, data) : onCreate!(data)), editing?.id)}
          onDelete={() => runWrite(() => onDelete!(editing!.id), editing?.id)}
          onClose={() => {
            setEditing(null);
            setAdding(false);
            setFilled(null);
            setWriteError(null);
          }}
          filled={editing ? null : filled}
        />
      )}
    </div>
  );
}
