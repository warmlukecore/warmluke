"use client";

// ─────────────────────────────────────────────────────────────
// A glimpse of the app, on the first screen.
//
// Not a drawing of the product: the product. The overview is the app's
// own OverviewBoard, a store section is the app's own table, the tracker
// Luke built is the app's own board, and the frame around them wears the
// app's tokens. Fed the sample store (src/lib/sample-store.ts) instead
// of a database, so a visitor who signs up opens the screen they were
// shown, not a cousin of it.
//
// A glimpse and not the whole: the app is drawn at its real size and
// zoomed to fit, it fades out at the bottom, and only the overview and
// the sections a merchant starts with can be opened. Luke's panel is
// there as it first appears, and pressing it goes to the part of the
// page that shows Luke working.
//
// Drawn only in the browser: the greeting and the dates are the
// visitor's today, which the server rendering the page cannot know.
//
// Callers: src/app/page.tsx.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bell, ChevronRight, ChevronsUpDown, LayoutDashboard, Menu, Plus, RefreshCw, Search, Settings, Sparkles, X, Zap } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { LukeMark } from "@/components/ui/LukeMark";
import { Icon } from "@/components/ui/Icon";
import { button, iconButton } from "@/components/ui/controls";
import { OverviewBoard, type OverviewData } from "@/components/Overview";
import { BoardView, TableView, compare } from "@/components/views";
import type { DetailRow } from "@/components/StoreRecordDetail";
import type { RecordRow, SchemaColumn } from "@/lib/types";
import { CORE_STORE_TABLES, STORE_TABLES, type StoreTable } from "@/lib/store-read";
import { LUKE_COPY } from "@/lib/luke-copy";
import { FormatProvider } from "@/lib/format";
import {
  CUSTOMERS,
  DAYS,
  FIGURES,
  LOW,
  LOW_STOCK,
  ORDERS,
  OUT,
  OWNER,
  RETURNS,
  STORE,
  VARIANTS,
  cityOf,
  sku,
  type Order,
} from "@/lib/sample-store";

/**
 * The size the app is drawn at on a laptop, before it is zoomed to fit.
 * The app's own breakpoints read the window, not this box, so it is
 * drawn as wide as the window those breakpoints expect: narrower, and
 * the overview's four figures crowd a canvas they were not laid out for.
 */
const WIDE = { w: 1440, h: 820 };
/** A phone draws the app's phone layout at least this wide, and this tall. */
const PHONE = { w: 390, h: 700 };
/** Under this many pixels across, the phone layout. */
const NARROW_BELOW = 700;
/** The order a return moves through, so the board's columns read left to right. */
const STAGES = ["Requested", "Received", "Refunded"];
/** The section Luke built in the sample store, shown under "Your sections". */
const TRACKER = { id: "returns-tracker", label: "Returns tracker", icon: "undo-2" } as const;

type Place = "overview" | StoreTable | typeof TRACKER.id;

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A moment n days before now, in the morning, so a day's orders keep to that day. */
const daysBack = (now: number, n: number, minutes = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  d.setHours(9, minutes, 0, 0);
  return d;
};
const statusOf = (o: Order) => (o.payment === "pending" ? "PENDING" : o.payment === "refunded" ? "REFUNDED" : "PAID");
const paidBy = (o: Order) => (o.payment === "pending" ? "Cash on Delivery (COD)" : "Shopify Payments");

/** What abo_store_overview would answer for the sample store, today. */
function overviewOf(now: number): OverviewData {
  const pending = ORDERS.filter((o) => o.payment === "pending");
  const paid = ORDERS.filter((o) => o.payment === "paid");
  const chartDays = 14;
  return {
    store: {
      shop_domain: STORE.domain,
      status: "connected",
      currency: STORE.currency,
      timezone: STORE.timezone,
      last_synced_at: new Date(now - STORE.synced * 60_000).toISOString(),
    },
    days: DAYS,
    chart_days: chartDays,
    today: localDay(new Date(now)),
    orders: {
      today: ORDERS.filter((o) => o.daysAgo === 0).length,
      yesterday: FIGURES.yesterday.orders,
      window: ORDERS.length,
    },
    money: [
      {
        currency: STORE.currency,
        collected: FIGURES.collected,
        awaiting: pending.reduce((s, o) => s + o.total, 0),
        awaiting_count: pending.length,
        awaiting_by: "Cash on Delivery (COD)",
        average: paid.length ? FIGURES.collected / paid.length : null,
        orders: ORDERS.length,
      },
    ],
    daily: Array.from({ length: chartDays }, (_, k) => ({
      day: localDay(daysBack(now, chartDays - 1 - k)),
      orders: ORDERS.filter((o) => o.daysAgo === chartDays - 1 - k).length,
    })),
    to_fulfil: ORDERS.filter((o) => !o.sent && o.payment !== "refunded").length,
    stock: { low: LOW.length, out: OUT.length },
    stock_watch: OUT.map((v) => ({
      id: sku(v),
      product: v.product,
      variant: v.option ?? null,
      location_name: STORE.location,
      sku: sku(v),
      available: v.stock,
      on_hand: v.stock,
      incoming: 0,
      stock_state: "Out of stock",
    })),
    watching: OUT.length,
    customers: CUSTOMERS.length,
    products: new Set(VARIANTS.map((v) => v.product)).size,
  };
}

/** The rows of each store section, shaped as the app reads them. */
function rowsOf(table: StoreTable, now: number): Array<Record<string, unknown>> {
  switch (table) {
    case "orders":
      return ORDERS.map((o, i) => ({
        order_number: `#${o.number}`,
        placed_at: daysBack(now, o.daysAgo, (i * 7) % 600).toISOString(),
        customer_name: o.customer,
        total: o.total,
        currency: STORE.currency,
        status: statusOf(o),
        fulfilment_status: o.sent ? "FULFILLED" : "UNFULFILLED",
        gateway: paidBy(o),
        ship_city: cityOf(o.customer),
      }));
    case "products":
      return [...new Set(VARIANTS.map((v) => v.product))].map((title) => ({
        title,
        product_type: VARIANTS.find((v) => v.product === title)!.category,
        vendor: STORE.project,
        status: "ACTIVE",
      }));
    case "customers":
      return CUSTOMERS.map((c) => ({ name: c.name, city: cityOf(c.name), orders_count: c.orders.length, total_spent: c.spent }));
    default:
      return [...VARIANTS]
        .sort((a, b) => a.stock - b.stock)
        .map((v) => ({
          product: v.product,
          variant: v.option ?? "Default",
          sku: sku(v),
          location_name: STORE.location,
          available: v.stock,
          on_hand: v.stock,
          incoming: 0,
          stock_state: v.stock <= 0 ? "Out of stock" : v.stock < LOW_STOCK ? "Low" : "In stock",
        }));
  }
}

const asRecords = (rows: Array<Record<string, unknown>>, module: string): RecordRow[] =>
  rows.map((data, i) => ({ id: `${module}-${i}`, project_id: "sample", module_id: module, data, created_at: "", updated_at: "" }));

/** A section's own columns, only those the sample store fills: an empty column is noise in a glimpse. */
const columnsFor = (table: StoreTable, rows: Array<Record<string, unknown>>): SchemaColumn[] =>
  STORE_TABLES[table].columns.filter((c) => rows.some((r) => r[c.field] !== undefined));

const TRACKER_COLUMNS: SchemaColumn[] = [
  { field: "order", label: "Order", type: "text" },
  { field: "item", label: "Item", type: "text" },
  { field: "reason", label: "Reason", type: "text" },
  { field: "stage", label: "Stage", type: "badge" },
  { field: "refund", label: "Refund", type: "currency" },
];

export function StorePreview() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width !== null && width < NARROW_BELOW;
  // A phone narrower than the phone layout is drawn at that width and zoomed down to fit.
  const drawn = width === null ? null : narrow ? { w: Math.max(PHONE.w, width), h: PHONE.h } : WIDE;
  const zoom = width === null || !drawn ? 1 : width / drawn.w;

  return (
    <section
      aria-label="A glimpse of Warmluke, on a sample store"
      className="rounded-2xl p-2 md:p-3"
      style={{
        background: "rgb(255 255 255 / 0.55)",
        border: "1px solid rgb(255 255 255 / 0.6)",
        boxShadow: "var(--shadow-dashboard)",
      }}
    >
      {/* The bottom fades out: this is a look in, not the whole app. */}
      <div
        ref={box}
        className="relative overflow-hidden rounded-xl text-left [mask-image:linear-gradient(to_bottom,black_80%,transparent)]"
        style={{ height: drawn ? drawn.h * zoom : undefined }}
      >
        {!drawn ? (
          <div className="aspect-[390/700] bg-frame md:aspect-[1440/820]" />
        ) : (
          <div style={{ width: drawn.w, height: drawn.h, zoom }}>
            <FormatProvider locale={STORE.locale} currency={STORE.currency}>
              <App now={now} narrow={narrow} />
            </FormatProvider>
          </div>
        )}
      </div>
    </section>
  );
}

function App({ now, narrow }: { now: number; narrow: boolean }) {
  const [place, setPlace] = useState<Place>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const data = useMemo(() => overviewOf(now), [now]);
  const latest: DetailRow[] = useMemo(
    () => rowsOf("orders", now).slice(0, 6).map((r, i) => ({ id: `latest-${i}`, data: r })),
    [now]
  );

  const go = (to: Place) => {
    setPlace(to);
    setSort(null);
    setNavOpen(false);
  };
  const store = CORE_STORE_TABLES.map((t) => ({ id: t, label: STORE_TABLES[t].section.label, icon: STORE_TABLES[t].section.icon }));
  const q = query.trim().toLowerCase();
  const shows = (label: string) => !q || label.toLowerCase().includes(q);
  const title = place === "overview" ? "Overview" : place === TRACKER.id ? TRACKER.label : STORE_TABLES[place].section.label;

  const item = (id: Place, label: string, glyph: React.ReactNode) => (
    <div
      key={id}
      className={`mb-1 flex items-center gap-1 rounded-lg pr-1 transition-colors ${
        place === id ? "bg-frame-raised text-white" : "text-frame-fg hover:bg-frame-raised/60 hover:text-white"
      }`}
    >
      <span className="w-[18px]" />
      <button
        onClick={() => go(id)}
        data-cta={`preview_${id}`}
        aria-current={place === id ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left text-sm"
      >
        {glyph}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );

  const heading = (text: string) => (
    <div className="mt-3 mb-1 flex items-center justify-between px-2 text-xs font-medium text-frame-fg-muted">
      {text}
      <Plus aria-hidden size={14} strokeWidth={2} />
    </div>
  );

  const nothing = q && !shows("Overview") && !store.some((s) => shows(s.label)) && !shows(TRACKER.label);

  const sidebar = (
    <aside
      className={`flex w-60 shrink-0 flex-col overflow-hidden bg-frame text-frame-fg ${
        narrow ? `absolute inset-y-0 left-0 z-40 transition-transform duration-200 ${navOpen ? "translate-x-0" : "-translate-x-full"}` : ""
      }`}
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <Logo className="h-5" onDark />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{STORE.project}</div>
          <div className="max-w-[9rem] truncate text-[11px] text-frame-fg-muted">{STORE.email}</div>
        </div>
        {narrow ? (
          <button onClick={() => setNavOpen(false)} aria-label="Close sections" className="ml-auto rounded-control p-1.5 text-frame-fg-muted hover:bg-frame-raised hover:text-white">
            <X aria-hidden size={16} strokeWidth={1.75} />
          </button>
        ) : (
          <span className="ml-auto rounded-control p-1.5 text-frame-fg-muted">
            <Settings aria-hidden size={16} strokeWidth={1.75} />
          </span>
        )}
      </div>
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-control bg-frame-raised px-2.5 py-1.5 text-sm text-frame-fg-muted focus-within:ring-2 focus-within:ring-focus">
          <Search aria-hidden size={15} strokeWidth={1.75} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search sections"
            className="w-full bg-transparent text-frame-fg outline-none placeholder:text-frame-fg-muted"
          />
        </label>
      </div>
      <nav aria-label="Sample store" className="flex-1 overflow-y-auto px-3 py-1">
        {shows("Overview") && item("overview", "Overview", <LayoutDashboard aria-hidden size={16} strokeWidth={1.75} />)}
        {store.some((s) => shows(s.label)) && heading("Store")}
        {store.filter((s) => shows(s.label)).map((s) => item(s.id, s.label, <Icon name={s.icon} />))}
        {shows(TRACKER.label) && heading("Your sections")}
        {shows(TRACKER.label) && item(TRACKER.id, TRACKER.label, <Icon name={TRACKER.icon} />)}
        {nothing && <p className="px-2 pt-1 text-xs text-frame-fg-muted">No section matches that.</p>}
      </nav>
      <div className="space-y-1 border-t border-frame-line px-3 py-3">
        <div className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[13px] text-frame-fg">
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-tone-success text-[11px] font-semibold text-tone-success-fg">
            {STORE.project.charAt(0)}
            <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-signal-success ring-2 ring-frame" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{STORE.domain.replace(".myshopify.com", "")}</span>
          <ChevronsUpDown aria-hidden size={14} strokeWidth={1.75} className="text-frame-fg-muted" />
        </div>
        <div className="flex items-center gap-2 px-2 py-1 text-[12px] text-frame-fg">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-success" />
          <span className="min-w-0 flex-1 leading-tight">
            Connected
            <span className="block text-[11px] text-frame-fg-muted">synced {STORE.synced} min ago</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-frame-fg-muted">
            <RefreshCw aria-hidden size={13} strokeWidth={2} />
            Check
          </span>
        </div>
      </div>
    </aside>
  );

  function canvas() {
    if (place === "overview") {
      return (
        <OverviewBoard
          data={data}
          latest={latest}
          name={OWNER.split(" ")[0]}
          now={now}
          importing={false}
          hasSection={(t) => CORE_STORE_TABLES.includes(t)}
          onOpenTable={(t) => go(t)}
          onInspect={(t) => CORE_STORE_TABLES.includes(t) && go(t)}
        />
      );
    }
    if (place === TRACKER.id) {
      const records = asRecords(
        [...RETURNS]
          .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))
          .map((r) => ({ order: `#${r.order.number}`, item: r.item, reason: r.reason, stage: r.stage, refund: r.order.total })),
        TRACKER.id
      );
      return (
        <BoardView
          columns={TRACKER_COLUMNS}
          records={records}
          allRecordCount={records.length}
          view={{ type: "board", groupBy: "stage", cardTitle: "order", cardFields: ["item", "reason", "refund"] }}
        />
      );
    }
    const rows = rowsOf(place, now);
    const columns = columnsFor(place, rows);
    const col = sort ? columns.find((c) => c.field === sort.field) : undefined;
    const sorted = col && sort ? [...rows].sort((a, b) => compare(a[col.field], b[col.field], col.type) * (sort.dir === "asc" ? 1 : -1)) : rows;
    const records = asRecords(sorted, place);
    return (
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <TableView
          columns={columns}
          records={records}
          allRecordCount={records.length}
          sort={sort}
          onSort={(field) => setSort((s) => (s?.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }))}
        />
      </div>
    );
  }

  const luke = (
    <aside className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-card bg-surface shadow-card">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <LukeMark />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">Luke</div>
            <div className="truncate text-[11px] text-fg-faint">{LUKE_COPY.tagline}</div>
          </div>
          <Bell aria-hidden size={16} strokeWidth={1.75} className="ml-auto text-fg-muted" />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <LukeMark size="lg" />
        <h2 className="mt-4 text-lg font-semibold text-fg">{LUKE_COPY.emptyTitle}</h2>
        <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-fg-muted">{LUKE_COPY.emptyBody}</p>
      </div>
      <a href="#mcp" data-cta="preview_own_ai" className="flex items-center gap-2.5 border-t border-line px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover">
        <span className="flex -space-x-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logos/claude.svg" alt="" className="h-6 w-6 rounded-full bg-surface p-1 ring-1 ring-line" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logos/openai.svg" alt="" className="h-6 w-6 rounded-full bg-surface p-1 ring-1 ring-line" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{LUKE_COPY.ownAi}</span>
        <ChevronRight aria-hidden size={15} strokeWidth={1.75} className="text-fg-faint" />
      </a>
      <div className="border-t border-line p-3">
        <a
          href="#luke"
          data-cta="preview_composer"
          className="flex items-end gap-2 rounded-2xl border border-line bg-surface px-3.5 py-2.5 transition-colors hover:border-line-strong"
        >
          <span className="flex-1 py-0.5 text-[13px] leading-6 text-fg-faint">{LUKE_COPY.placeholder}</span>
          <span className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-line-strong text-surface">
            <ArrowUp aria-hidden size={16} strokeWidth={2.25} />
          </span>
        </a>
        <p className="mt-1.5 text-[10px] text-fg-faint">{LUKE_COPY.promise}</p>
      </div>
    </aside>
  );

  return (
    <div
      className={`font-ui relative flex h-full overflow-hidden bg-frame text-fg ${narrow ? "" : "gap-2 p-2 pl-0"}`}
      // Headings inside the app are set in the same face as the rest, as
      // the app itself does; the display face belongs to the landing page.
      style={{ ["--font-display" as string]: "var(--font-inter)" }}
    >
      {narrow && navOpen && <div onClick={() => setNavOpen(false)} className="absolute inset-0 z-30 bg-black/40" />}
      {sidebar}
      <main className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas ${narrow ? "" : "rounded-card shadow-card"}`}>
        <header className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-3 py-3 sm:px-6 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {narrow && (
              <button onClick={() => setNavOpen(true)} aria-label="Open sections" className={`${iconButton} -ml-1`}>
                <Menu aria-hidden size={18} strokeWidth={1.75} />
              </button>
            )}
            <h1 className="truncate text-base font-semibold text-fg sm:text-lg">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span className={button("secondary")}>
              <Zap aria-hidden size={15} strokeWidth={1.75} />
              {!narrow && <span>Rules</span>}
            </span>
            {narrow && (
              <a href="#luke" aria-label="Ask Luke" data-cta="preview_luke" className={button("primary")}>
                <Sparkles aria-hidden size={15} strokeWidth={1.75} />
              </a>
            )}
          </div>
        </header>
        <div key={place} className="thin-scroll rise flex-1 overflow-y-auto p-4 [--rise-after:0s] [--rise-for:0.3s] [--rise-from:6px] sm:p-6">
          {canvas()}
        </div>
      </main>
      {!narrow && luke}
    </div>
  );
}
