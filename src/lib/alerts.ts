// What Luke noticed (0163), in words. The database finds each one and
// keeps its facts; what it says, what Luke is asked about it, and what
// its settings are called live here, one entry a kind.
//
// A kind the database has and this list does not yet (a new source
// turned on before the app knows its words) still shows, plainly, with
// no question for Luke: an alert is never dropped for want of a sentence.
//
// Callers: src/components/Alerts.tsx, src/components/AppShell.tsx,
// src/components/ProjectSettings.tsx.

import type { LucideIcon } from "lucide-react";
import { hiddenColumns, type StoreTable } from "@/lib/store-read";
import { Bell, BellRing, MessageSquareWarning, PackageMinus, TrendingUp, Truck } from "lucide-react";

export type Alert = {
  id: string;
  kind: string;
  subject: string;
  severity: "attention" | "critical";
  facts: Record<string, unknown>;
  opened_at: string;
  changed_at: string;
  conversation_id: string | null;
  /** The rule that raised it (0164), for one of their own. */
  rule_id?: string | null;
  read: boolean;
};

export type AlertSetting = {
  kind: string;
  area: string;
  needs: string[];
  enabled: boolean;
  defaults: Record<string, number>;
  settings: Record<string, number>;
  /** Every import it needs is done. */
  ready: boolean;
  /** The project has said whether it wants this one (0164): the picker is not asked again. */
  chosen?: boolean;
};

type Facts = {
  str: (k: string) => string;
  num: (k: string) => number;
  list: (k: string) => string[];
  raw: (k: string) => unknown;
};

type Words = {
  icon: LucideIcon;
  /** What the kind is, in Settings. */
  name: string;
  /** What it watches for, in Settings. */
  about: string;
  title: (f: Facts) => string;
  detail: (f: Facts) => string;
  /** What Luke is asked; none, and the alert offers no question. */
  ask?: (f: Facts) => string;
  /** Its settings, in order: the words before the number, and after. */
  settings: Array<{ key: string; before: string; after: string }>;
  /** The store list columns it is worked out from: one the account is not shown (0192) keeps it off their screen. */
  reads?: Array<[StoreTable, string]>;
};

const factsOf = (raw: Record<string, unknown>): Facts => ({
  str: (k) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : ""),
  num: (k) => Number(raw[k]) || 0,
  list: (k) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is string => typeof x === "string") : []),
  raw: (k) => raw[k],
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const waited = (hours: number) => (hours >= 48 ? plural(Math.floor(hours / 24), "day") : plural(hours, "hour"));
const named = (f: Facts) => [f.str("product"), f.str("variant")].filter(Boolean).join(" · ") || "A product";
const titled = (kind: string) => kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const ALERT_WORDS: Record<string, Words> = {
  low_stock: {
    reads: [["inventory_levels", "available"]],
    icon: PackageMinus,
    name: "Running low",
    about: "A product that will run out soon at the pace it sells.",
    title: (f) => {
      const left = f.num("days_left");
      const when =
        f.num("available") === 0
          ? "is out of stock"
          : left < 1
            ? "runs out today"
            : `runs out in about ${plural(left, "day")}`;
      return `${named(f)} ${when}`;
    },
    detail: (f) => `${f.num("available")} left · sells about ${f.num("per_day")} a day`,
    ask: (f) =>
      `${named(f)}${f.str("sku") ? ` (SKU ${f.str("sku")})` : ""} has ${f.num("available")} left and sells about ${f.num("per_day")} a day over the last ${plural(f.num("sales_days"), "day")}, so it runs out in about ${plural(f.num("days_left"), "day")}. How much should I reorder, and what should I do until it arrives?`,
    settings: [
      { key: "days_left", before: "Tell me when stock lasts", after: "days or fewer" },
      { key: "sales_days", before: "Judging by sales over the last", after: "days" },
    ],
  },
  dispatch_late: {
    reads: [
      ["orders", "fulfilment_status"],
      ["orders", "placed_at"],
    ],
    icon: Truck,
    name: "Late to send",
    about: "Orders still not sent long after they were placed.",
    title: (f) => `${plural(f.num("count"), "order")} not sent after ${waited(f.num("hours"))}`,
    detail: (f) =>
      [`The oldest has waited ${waited(f.num("oldest_hours"))}`, f.list("orders").join(", ")]
        .filter(Boolean)
        .join(" · "),
    ask: (f) =>
      `${plural(f.num("count"), "order")} ${f.num("count") === 1 ? "has" : "have"} not been sent ${waited(f.num("hours"))} after being placed${
        f.list("orders").length ? ` (${f.list("orders").join(", ")})` : ""
      }; the oldest has waited ${waited(f.num("oldest_hours"))}. What is holding them, and which should go first?`,
    settings: [
      { key: "hours", before: "Late when not sent after", after: "hours" },
      { key: "since_days", before: "Looking at orders from the last", after: "days" },
    ],
  },
  returns_spike: {
    icon: TrendingUp,
    name: "Returns rising",
    about: "A product coming back far more often than it usually does.",
    title: (f) => `${f.str("product") || "A product"}: ${plural(f.num("this_week"), "return")} this week`,
    detail: (f) =>
      f.num("per_week") > 0 ? `About ${f.num("per_week")} a week before` : "None in the four weeks before",
    ask: (f) =>
      `${f.str("product") || "A product"} had ${plural(f.num("this_week"), "return")} this week, against ${
        f.num("per_week") > 0 ? `about ${f.num("per_week")} a week` : "none"
      } in the four weeks before. Why are they coming back, and what should I change?`,
    settings: [
      { key: "min", before: "At least", after: "returns in a week" },
      { key: "times", before: "And at least", after: "times its usual week" },
    ],
  },
  return_reason: {
    reads: [["returns", "reasons"]],
    icon: MessageSquareWarning,
    name: "A return reason repeats",
    about: "The same reason given for returns again and again.",
    title: (f) => `“${f.str("reason")}” ${plural(f.num("count"), "time")} in ${plural(f.num("days"), "day")}`,
    detail: (f) => {
      const said = f.list("notes")[0];
      return [f.list("products").join(", "), said ? `“${said}”` : ""].filter(Boolean).join(" · ");
    },
    ask: (f) =>
      `Customers gave “${f.str("reason")}” as the reason for ${plural(f.num("count"), "return")} in the last ${plural(f.num("days"), "day")}${
        f.list("products").length ? `, for ${f.list("products").join(", ")}` : ""
      }${
        f.list("notes").length
          ? `. They wrote: ${f
              .list("notes")
              .map((n) => `“${n}”`)
              .join(" ")}`
          : ""
      }. What is behind it, and what should I fix?`,
    settings: [
      { key: "min", before: "The same reason at least", after: "times" },
      { key: "days", before: "Within", after: "days" },
    ],
  },
};

/**
 * One of their own (0164): a rule Luke wrote from their words. Its
 * title is theirs; the fields it shows say which row.
 */
const RULE: Words = {
  icon: BellRing,
  name: "Your alerts",
  about: "What you asked Luke to tell you about.",
  title: (f) => f.str("title") || "Your alert",
  detail: (f) => ruleValues(f).join(" · "),
  ask: (f) => {
    const which = ruleValues(f).join(", ");
    return `My alert “${f.str("title") || "Your alert"}” went off${which ? ` (${which})` : ""}. What should I do about it?`;
  },
  settings: [],
};
const ruleValues = (f: Facts) =>
  ((f.raw("values") as Array<{ value?: unknown }> | undefined) ?? [])
    .map((v) => (typeof v?.value === "string" ? v.value.trim() : ""))
    .filter(Boolean);

/** What Luke will watch once the data for it is read; shown, never ticked. */
export const ALERTS_COMING: Array<{ name: string; about: string; icon: LucideIcon }> = [
  { name: "Conversion changes", about: "Once Warmluke reads your store's visits.", icon: TrendingUp },
  { name: "Ads spending without sales", about: "Once your ads account is connected.", icon: Bell },
];

export const wordsOf = (kind: string): Words =>
  kind === "rule"
    ? RULE
    : (ALERT_WORDS[kind] ?? {
        icon: Bell,
        name: titled(kind),
        about: "",
        title: () => titled(kind),
        detail: () => "",
        settings: [],
      });

/** What one alert says: its mark, its two lines, and its question for Luke if it has one. */
export function describeAlert(a: Pick<Alert, "kind" | "facts">) {
  const w = wordsOf(a.kind);
  const f = factsOf(a.facts ?? {});
  return { icon: w.icon, title: w.title(f), detail: w.detail(f), ask: w.ask?.(f) ?? null };
}

/** The imports a kind waits for, as the merchant knows them. */
export const NEEDS_NAMES: Record<string, string> = {
  orders: "orders",
  inventory: "stock",
  fulfillments: "shipments",
  returns: "returns",
};

/** Whether this account is shown an alert: not one worked out from a store column it is not shown (0192). */
export const alertShown = (a: Pick<Alert, "kind">) =>
  !(ALERT_WORDS[a.kind]?.reads ?? []).some(([table, field]) => hiddenColumns(table)?.has(field));
