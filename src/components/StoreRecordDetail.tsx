"use client";

// ─────────────────────────────────────────────────────────────
// One row from the store, opened: an order with its items, payments,
// shipments and refunds; a customer with their orders; a product with
// its variants and sales. Everything is read-only — the import owns
// these rows — and every value is drawn by the same Cell the table uses,
// so money, dates and statuses read the same in both places.
//
// A related row opens in place, with a way back, so a merchant can go
// from a customer to one of their orders and return without losing
// where they were.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { RELATED, STORE_TABLES, ordersOfCustomer, readRelated, type StoreTable } from "@/lib/store-read";
import type { SchemaColumn } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Group } from "@/components/ui/Group";
import { button, note } from "@/components/ui/controls";
import { Badge, Cell } from "@/components/views";

export type DetailRow = { id: string; data: Record<string, unknown> };
type Frame = { table: StoreTable; row: DetailRow; columns: SchemaColumn[] };
/** "parent" is the one row this belongs to; "children" belong to this row. */
type Related = { title: string; table: StoreTable; rows: DetailRow[]; kind: "parent" | "children" };

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/**
 * What to call a row at the top of its page. Most lists lead with their
 * name; the ones that lead with an order number are about something
 * inside or around that order, and say so.
 */
function titleOf(table: StoreTable, row: DetailRow, head?: SchemaColumn): string {
  const d = row.data;
  const order = text(d.order_number);
  switch (table) {
    case "orders":
      return order ? `Order ${order}` : "Order";
    case "order_line_items":
    case "draft_order_items":
      return [text(d.title), text(d.variant_title)].filter(Boolean).join(" · ") || "Item";
    case "refunds":
      return order ? `Refund on ${order}` : "Refund";
    case "transactions":
      return order ? `Payment on ${order}` : "Payment";
    case "fulfillments":
      return order ? `Shipment for ${order}` : "Shipment";
    case "inventory_levels":
      return [text(d.product), text(d.variant)].filter(Boolean).join(" · ") || "Stock";
    default:
      return (head && text(d[head.field])) || STORE_TABLES[table].section.label;
  }
}

const currencyOf = (col: SchemaColumn, row: DetailRow) =>
  col.currencyField ? ((row.data[col.currencyField] as string | undefined) ?? null) : null;
const present = (v: unknown) => v !== null && v !== undefined && v !== "";

export default function StoreRecordDetail({
  table,
  row,
  columns,
  storeId,
  onClose,
}: {
  table: StoreTable;
  row: DetailRow;
  /** The section's own columns when opened from one; the list's otherwise. */
  columns?: SchemaColumn[];
  storeId: string;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<Frame[]>([{ table, row, columns: columns ?? STORE_TABLES[table].columns }]);
  const top = stack[stack.length - 1];
  const spec = STORE_TABLES[top.table];

  const [related, setRelated] = useState<Related[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parentOrder = typeof top.row.data.order_id === "string" ? top.row.data.order_id : null;
  useEffect(() => {
    let live = true;
    setRelated(null);
    setError(null);
    (async () => {
      try {
        const reads: Array<Promise<Related>> = [];
        // A line, payment, shipment or refund belongs to an order: show it first.
        if (top.table !== "orders" && parentOrder) {
          reads.push(
            readRelated(supabase, storeId, "orders", "id", parentOrder, 1).then((rows) => ({
              title: "Order",
              table: "orders",
              rows,
              kind: "parent" as const,
            }))
          );
        }
        if (top.table === "customers") {
          reads.push(
            ordersOfCustomer(supabase, storeId, top.row.id).then((rows) => ({
              title: "Orders",
              table: "orders",
              rows,
              kind: "children" as const,
            }))
          );
        }
        for (const rel of RELATED[top.table] ?? []) {
          reads.push(
            readRelated(supabase, storeId, rel.table, rel.by, top.row.id).then((rows) => ({
              title: rel.title,
              table: rel.table,
              rows,
              kind: "children" as const,
            }))
          );
        }
        const out = await Promise.all(reads);
        if (live) setRelated(out);
      } catch (e) {
        if (live) {
          setError(e instanceof Error ? e.message : "What belongs to this couldn't be read.");
          setRelated([]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [top.table, top.row.id, parentOrder, storeId]);

  const [head, ...rest] = top.columns;
  const value = (c: SchemaColumn) => top.row.data[c.field];
  const badges = rest.filter((c) => c.type === "badge" && present(value(c)));
  // The first amount always; the rest only when they say something the
  // first does not — a nil shipping line or a "before refunds" equal to
  // the total is a box of nothing.
  const amounts = top.columns.filter((c) => c.type === "currency" && present(value(c)));
  const money = amounts.filter(
    (c, i) => i === 0 || (Number(value(c)) !== 0 && Number(value(c)) !== Number(value(amounts[0])))
  );
  // What the heading already says, and empty fields, are left out.
  const facts = rest.filter((c) => c.type !== "badge" && c.type !== "currency" && present(value(c)));
  const title = titleOf(top.table, top.row, head);
  // The column the heading was not made from still belongs in the details.
  const details = [...(head && present(value(head)) && !title.includes(text(value(head))) ? [head] : []), ...facts];

  return (
    <Dialog tall title={title} description={spec.section.label} onClose={onClose}>
      <div className="space-y-4">
        {stack.length > 1 && (
          <button onClick={() => setStack((s) => s.slice(0, -1))} className={`${button("plain", "sm")} -ml-2.5`}>
            <ArrowLeft aria-hidden size={14} strokeWidth={2} />
            Back to {STORE_TABLES[stack[stack.length - 2].table].section.label.toLowerCase()}
          </button>
        )}

        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {badges.map((c) => (
              <span key={c.field} title={c.label}>
                <Badge value={String(top.row.data[c.field])} />
              </span>
            ))}
          </div>
        )}

        {money.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {money.map((c) => (
              <div key={c.field} className="rounded-control border border-line px-3 py-2">
                <div className="text-[11px] text-fg-muted">{c.label}</div>
                <div className="mt-0.5 text-sm">
                  <Cell col={c} value={top.row.data[c.field]} currency={currencyOf(c, top.row)} />
                </div>
              </div>
            ))}
          </div>
        )}

        {details.length > 0 && (
          <Group title="Details">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {details.map((c) => (
                <div key={c.field} className="min-w-0">
                  <dt className="text-[11px] text-fg-muted">{c.label}</dt>
                  <dd className="mt-0.5 truncate text-[13px] text-fg">
                    <Cell col={c} value={top.row.data[c.field]} currency={currencyOf(c, top.row)} />
                  </dd>
                </div>
              ))}
            </dl>
          </Group>
        )}

        {error && <div className={note.critical}>{error}</div>}

        {related === null ? (
          <div className="h-24 animate-pulse rounded-card bg-surface-hover" aria-busy />
        ) : (
          related
            .filter((r) => r.rows.length > 0)
            .map((r) => (
              <RelatedList
                key={r.title}
                related={r}
                parent={top.row}
                onOpen={(child) =>
                  setStack((s) => [...s, { table: r.table, row: child, columns: STORE_TABLES[r.table].columns }])
                }
              />
            ))
        )}
      </div>
    </Dialog>
  );
}

/** A related list as a small table; columns that only repeat the row above are left out. */
function RelatedList({
  related,
  parent,
  onOpen,
}: {
  related: Related;
  parent: DetailRow;
  onOpen: (row: DetailRow) => void;
}) {
  const cols = useMemo(() => {
    const all = STORE_TABLES[related.table].columns.filter((c) => related.rows.some((r) => present(r.data[c.field])));
    // The order a line belongs to is named by its own number, date and
    // total, even though the line repeats them; children leave out what
    // only repeats the row above.
    if (related.kind === "parent") {
      const badge = all.find((c) => c.type === "badge");
      const lead = all.filter((c) => c.type !== "badge").slice(0, 2);
      const total = all.find((c) => c.type === "currency");
      return [...lead, ...(total && !lead.includes(total) ? [total] : []), ...(badge ? [badge] : [])];
    }
    // A value the row above already shows, under whatever name — the
    // customer's own name and phone on each of their orders, the
    // product's title on each of its variants — says nothing new.
    const known = new Set(Object.values(parent.data).map(text).filter(Boolean));
    return all.filter((c) => !related.rows.every((r) => known.has(text(r.data[c.field])))).slice(0, 5);
  }, [related, parent]);

  return (
    <section className="overflow-hidden rounded-card border border-line">
      <header className="flex items-center justify-between border-b border-line bg-surface-subdued px-4 py-2.5">
        <h3 className="text-[13px] font-semibold text-fg">{related.title}</h3>
        <span className="text-xs text-fg-muted tabular-nums">{related.rows.length}</span>
      </header>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[11px] text-fg-muted">
            <tr>
              {cols.map((c) => (
                <th key={c.field} className="px-4 py-2 font-medium whitespace-nowrap">
                  {c.label}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {related.rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(r);
                  }
                }}
                className="cursor-pointer transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                {cols.map((c) => (
                  <td key={c.field} className="max-w-[12rem] truncate px-4 py-2 text-fg">
                    <Cell col={c} value={r.data[c.field]} currency={currencyOf(c, r)} />
                  </td>
                ))}
                <td className="pr-3 text-fg-faint">
                  <ChevronRight aria-hidden size={14} strokeWidth={1.75} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
