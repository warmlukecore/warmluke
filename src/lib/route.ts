// A merchant's question, read before Luke sees it: which of the shop's
// lists would answer it, over what span, and what kind of answer they
// want. Three small independent choices to a decision model — the kind
// of thing it is for (list 38/40, window 39/40, kind 35/40 on forty
// real questions, half of them Hinglish) — and nothing else.
//
// A router, never a gate. When the model is unsure, or the text is not
// a question about the data, or the model is not there, this returns
// null and the turn runs exactly as it did before: the fixed snapshot,
// Luke deciding everything. A wrong route costs one extra slice of rows
// Luke is told the reason for; it never costs a refusal.
//
// Facts are not asked of it. What is looked up — a name, an order
// number — comes from the words themselves (candidates), and the rows
// come from the database.

import { askJev } from "@/lib/jev";
import type { StoreTable } from "@/lib/store-read";

export type RouteList = "orders" | "customers" | "products" | "stock" | "sales";
export type RouteWindow =
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_month"
  | "named_month"
  | "all";
export type RouteKind = "ranking" | "lookup" | "total";

export type Route = {
  list: RouteList;
  window: RouteWindow;
  /** 1–12 when the window is a named month. */
  month: number | null;
  kind: RouteKind;
  /** Words worth looking up — order numbers, names, product words. */
  needles: string[];
  confidence: { list: number; kind: number; window: number };
  ms: number;
};

/** The store list each route reads. */
export const ROUTE_TABLE: Record<RouteList, StoreTable> = {
  orders: "orders",
  customers: "customers",
  products: "products",
  stock: "inventory_levels",
  sales: "product_sales",
};

const LISTS: RouteList[] = ["orders", "customers", "products", "stock", "sales"];
const WINDOWS: RouteWindow[] = ["today", "yesterday", "this_week", "this_month", "last_month", "named_month", "all"];
const KINDS: RouteKind[] = ["ranking", "lookup", "total"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Below this on list or kind, the route is not taken. The misses measured all sat under it. */
const GATE = 0.5;
// Measured p50 ~500ms, p95 ~1.9s. It runs beside the store reads, so
// the turn waits only for the tail of this; a tail past three seconds
// is the fixed snapshot alone, as before.
const TIMEOUT_MS = 3000;

// Worded and measured together; the examples are what the model reads,
// and moving "how much did we sell in January" from sales to orders
// took the list score from 36 to 38 of 40.
const QUESTIONS = {
  list: {
    type: "choice",
    instructions: {
      question: "Which of the shop's lists would answer `question`?",
      not_for: "Whether the answer is easy, or whether the shop has the data",
    },
    criteria: {
      orders: {
        what: "Orders placed in the shop — order numbers, when placed, totals, paid or pending or cancelled, who ordered, and any money made over a period",
        examples: ["how many orders today", "is #1004 paid", "revenue this week", "pending COD total", "how much did we sell in January", "top cities by sales"],
      },
      customers: {
        what: "The people who buy — names, phones, emails, cities, how many orders each has placed, lifetime spend",
        examples: ["who is my top buyer", "Aman ka phone number", "customers from Delhi", "repeat customers"],
      },
      products: {
        what: "The catalogue — product titles, categories, vendors, status, tags",
        examples: ["how many products are active", "which vendor do we stock most", "is Ski Wax listed"],
      },
      stock: {
        what: "Inventory levels — how many of each variant at each location, what is running low",
        examples: ["stock of ski wax", "what is running low", "kitna maal bacha hai"],
      },
      sales: {
        what: "Which PRODUCTS sold — units and revenue per product, best sellers, ranked products",
        not_for: "How much the shop made over a period, or who bought — those are orders and customers",
        examples: ["best sellers", "kaunsa product sabse zyada bika", "which product earned most this month"],
      },
      none: {
        what: "Not a question about the shop's data: a request to build or change something in the app, small talk, a how-to about the app itself, or something no list could answer",
        examples: ["make a returns section", "add a column to orders", "hi", "how do I connect shopify"],
      },
    },
  },
  window: {
    type: "choice",
    instructions: {
      question: "What time span does `question` ask about?",
      not_for: "Guessing a span the question does not mention — a question with no time in it is all time",
    },
    criteria: {
      today: { what: "Today only", examples: ["aaj kitne order aaye", "today's revenue"] },
      yesterday: { what: "Yesterday only", examples: ["kal ke orders", "yesterday's sales"] },
      this_week: { what: "The last seven days, or this week", examples: ["orders this week", "is hafte"] },
      this_month: { what: "The last thirty days, or this month", examples: ["revenue this month", "is mahine ka best seller"] },
      last_month: { what: "The previous calendar month", examples: ["last month's orders", "pichhle mahine"] },
      named_month: { what: "A month named by name — January, August, March", examples: ["August ka top buyer", "orders in March"] },
      all: { what: "No time span mentioned, or explicitly all time / ever / total", examples: ["who is my top buyer", "how many customers do I have", "best sellers"] },
    },
  },
  month: {
    type: "choice",
    instructions: {
      question: "If `question` names a month, which one? Otherwise none.",
      not_for: "Relative spans like this month or last month — those are none",
    },
    criteria: Object.fromEntries([...MONTHS.map((m) => [m, m]), ["none", "no month is named"]]),
  },
  kind: {
    type: "choice",
    instructions: {
      question: "What kind of answer does `question` want?",
      not_for: "Which list it is about",
    },
    criteria: {
      ranking: { what: "The top, the most, the biggest, the best, sorted by something — a ranked list or its first entry", examples: ["top buyer", "best sellers", "which city buys most", "sabse zyada"] },
      lookup: { what: "One particular thing by name or number — an order, a customer, a product, a stock level", examples: ["is #1004 paid", "Aman ka phone", "stock of ski wax"] },
      total: { what: "How many, how much, a sum, an average, a count", examples: ["how many orders today", "revenue this week", "kitne customers hain"] },
      build: { what: "A request to build, add, change or remove something in the app — not a question", examples: ["make a section", "add a column", "rename Packing"] },
      unclear: { what: "Small talk, a how-to about the app, or too vague to say", examples: ["hi", "make it better", "how do I connect shopify"] },
    },
  },
};

// Words that are never the thing being looked up, in either language.
const STOP = new Set(
  "a an the of in on at to for from by with is are was were be do does did has have had how what which who when where why kya kaun kaunsa kitna kitne ka ke ki ko me mein se ne hai hain tha the thi kar do dikhao batao and or not no this that these those my our your i we you it its over under about last next month week today yesterday all show me tell give list paid pending cancelled unpaid order orders customer customers product products stock sales revenue total totals phone number email price cod".split(
    " "
  )
);

/**
 * The words worth looking up: order numbers, and every one- or two-word
 * run that is not filler. Deterministic on purpose — asking the model
 * to pick the needle was right 4 times in 9; searching for all of them
 * and letting the rows decide costs nothing and misses nothing.
 */
export function candidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#\d+/g)) out.add(m[0]);
  const words = text.replace(/[?!.,;:()"“”']/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (STOP.has(w.toLowerCase()) || /^\d+$/.test(w) || w.length < 3) continue;
    out.add(w);
    const n = words[i + 1];
    if (n && !STOP.has(n.toLowerCase()) && !/^\d+$/.test(n)) out.add(`${w} ${n}`);
  }
  return [...out].slice(0, 20);
}

/** Reads the question. Null means "run the turn as before". */
export async function routeQuestion(text: string, timeoutMs = TIMEOUT_MS): Promise<Route | null> {
  const question = text.trim();
  if (question.length < 3) return null;
  const t0 = Date.now();
  const got = await askJev("route", { question: question.slice(0, 500) }, QUESTIONS, timeoutMs);
  if (!got) return null;
  const { answers: a } = got;
  const list = a.list?.choice as RouteList | "none" | undefined;
  const kind = a.kind?.choice as RouteKind | "build" | "unclear" | undefined;
  const window = a.window?.choice as RouteWindow | undefined;
  const monthName = a.month?.choice ?? "none";
  const conf = {
    list: a.list?.confidence ?? 0,
    kind: a.kind?.confidence ?? 0,
    window: a.window?.confidence ?? 0,
  };
  // Not a question about the data, or not sure enough that it is: no route.
  if (!list || !kind || !window) return null;
  if (!LISTS.includes(list as RouteList) || !KINDS.includes(kind as RouteKind)) return null;
  if (conf.list < GATE || conf.kind < GATE) return null;
  const win = WINDOWS.includes(window) ? window : "all";
  const month = win === "named_month" ? MONTHS.indexOf(monthName) + 1 || null : null;
  return {
    list: list as RouteList,
    window: month === null && win === "named_month" ? "all" : win,
    month,
    kind: kind as RouteKind,
    needles: candidates(question),
    confidence: conf,
    ms: Date.now() - t0,
  };
}
