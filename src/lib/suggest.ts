// What Luke's empty panel offers to ask, read off the store itself (5 Oct).
//
// Four invented problems once sat there, written to show what the engine
// could do, and to a shop selling phone cases they read as a product for
// somebody else. These are this store's own numbers: its COD share, its
// failed deliveries, its refunds, its low stock. Each is offered only
// when the store shows it, and never for a need a section already meets.
// Tapped, the words go to Luke like any other message.
//
// Callers: src/components/AppShell.tsx, scripts/check-suggest.mjs.

import type { NextStep } from "@/lib/types";
import { hiddenColumns, type StoreTable } from "@/lib/store-read";

/** What the store shows, counted: the facts the offers are made from. */
export type StoreSignals = {
  /** Orders in the last 30 days, and of them paid cash on delivery. */
  orders30: number;
  cod30: number;
  /** Deliveries that failed or were attempted and not made. */
  failedDeliveries: number;
  /** Refunds in the last 60 days. */
  refunds60: number;
  /** Variants at 5 or fewer, anywhere. */
  lowStock: number;
  /** Customers with two orders or more. */
  repeatCustomers: number;
  /** Orders not shipped two days or more after they were placed. */
  lateUnshipped: number;
  /** Carts left in the last 30 days. */
  abandoned30: number;
};

/**
 * The store list columns each signal is counted by (storeSignals): one the
 * account is not shown (0192) leaves the signal out, so no offer says what
 * the column holds ("40% of orders are COD" with how it was paid hidden).
 */
export const SIGNAL_READS: Record<keyof StoreSignals, Array<[StoreTable, string]>> = {
  orders30: [["orders", "placed_at"]],
  cod30: [
    ["orders", "placed_at"],
    ["orders", "gateway"],
  ],
  failedDeliveries: [["fulfillments", "shipment_status"]],
  refunds60: [["refunds", "refunded_at"]],
  lowStock: [["inventory_levels", "available"]],
  repeatCustomers: [["customers", "orders_count"]],
  lateUnshipped: [
    ["orders", "fulfilment_status"],
    ["orders", "placed_at"],
  ],
  abandoned30: [["carts", "started_at"]],
};

type Offer = {
  /** How strongly the store shows the need: the order offers are made in. */
  weight: number;
  /** Words a section meeting this need would be named by. */
  met: RegExp;
  ask: NextStep;
};

/** At most this many: a few that fit beat a list to choose from. Each label
 * fits one row of the panel at desktop width (about 42 characters). */
const AT_MOST = 3;

/**
 * The asks this store's own numbers make for, strongest first, leaving
 * out any a section of theirs already meets (by its name). None when the
 * store shows nothing: then the panel asks for their own words alone.
 */
export function asksFromStore(counted: StoreSignals, sectionNames: string[]): NextStep[] {
  const s = Object.fromEntries(
    Object.entries(counted).map(([k, v]) => [
      k,
      SIGNAL_READS[k as keyof StoreSignals]?.some(([t, f]) => hiddenColumns(t)?.has(f)) ? 0 : v,
    ])
  ) as StoreSignals;
  const offers: Offer[] = [];
  const share = s.orders30 > 0 ? s.cod30 / s.orders30 : 0;
  if (s.cod30 >= 3 && share >= 0.15)
    offers.push({
      weight: 3 + share,
      met: /\bcod\b|confirm/i,
      ask: {
        label: `${Math.round(share * 100)}% of orders are COD: confirm them first`,
        prompt:
          "Set up COD confirmation: my COD orders to call before dispatch, each Pending, Confirmed, Cancelled or Not reachable, with how many calls and when we last called.",
      },
    });
  if (s.failedDeliveries >= 1)
    offers.push({
      weight: 3 + Math.min(s.failedDeliveries, 20) / 10,
      met: /\brto\b|\bndr\b|deliver|shipment/i,
      ask: {
        label: `${s.failedDeliveries} ${s.failedDeliveries === 1 ? "delivery" : "deliveries"} failed: follow them up`,
        prompt:
          "Track failed deliveries: each one with the courier, the reason, our call to the customer, and whether it went out again or came back to us (RTO).",
      },
    });
  if (s.refunds60 >= 2)
    offers.push({
      weight: 2 + Math.min(s.refunds60, 20) / 10,
      met: /return|refund|exchange/i,
      ask: {
        label: `${s.refunds60} refunds in 2 months: log returns`,
        prompt:
          "Set up a returns log: pick the order and its item, with the reason and a status of Requested, Received, Refunded or Exchanged, and how many each week.",
      },
    });
  if (s.lowStock >= 1)
    offers.push({
      weight: 2 + Math.min(s.lowStock, 20) / 10,
      met: /stock|inventory|reorder/i,
      ask: {
        label: `${s.lowStock} ${s.lowStock === 1 ? "item" : "items"} at 5 or fewer: get an alert`,
        prompt: "Tell me when any variant's stock goes to 5 or fewer, and keep a list of what to reorder.",
      },
    });
  if (s.lateUnshipped >= 3)
    offers.push({
      weight: 2 + Math.min(s.lateUnshipped, 20) / 20,
      met: /dispatch|ship\s?by|packing/i,
      ask: {
        label: `${s.lateUnshipped} orders late to ship: a dispatch board`,
        prompt:
          "Make a dispatch board: unshipped orders by their ship-by date, two working days after the order, late ones on top.",
      },
    });
  if (s.repeatCustomers >= 3)
    offers.push({
      weight: 1.5,
      met: /repeat|loyal/i,
      ask: {
        label: `${s.repeatCustomers} repeat customers: tag them`,
        prompt:
          "Show my repeat customers, two orders or more, and tag them, with how many orders and how much each has spent.",
      },
    });
  if (s.abandoned30 >= 3)
    offers.push({
      weight: 1,
      met: /cart|abandon/i,
      ask: {
        label: `${s.abandoned30} carts left this month: follow up`,
        prompt:
          "Track abandoned carts to follow up: who, what, how much, our call or message, and whether they came back to buy.",
      },
    });
  return offers
    .filter((o) => !sectionNames.some((n) => o.met.test(n)))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, AT_MOST)
    .map((o) => o.ask);
}
