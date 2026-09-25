// ─────────────────────────────────────────────────────────────
// The sample store the landing page shows.
//
// A visitor has no store, and the landing must never show somebody
// else's, so the page runs on this one: a month of orders, the stock
// behind them, the customers who placed them. Everything the page says
// about "your store" is read from here: the glimpse of the app at the
// top (its overview and sections), and what Luke answers and draws
// below it. Nothing is written twice, so nothing can disagree.
//
// The orders are built by arithmetic, not chance: the same month on
// every build, on the server and in the browser alike.
//
// No imports, so the checks run it as the page does.
//
// Callers: src/components/StorePreview.tsx, src/components/Landing.tsx,
// src/app/page.tsx.
// ─────────────────────────────────────────────────────────────

export const OWNER = "Jane Bishop";
/** The store itself, as the app's sidebar and header name it. */
export const STORE = {
  project: "Bishop & Co",
  domain: "bishop-and-co.myshopify.com",
  email: "jane@bishopandco.com",
  location: "Main warehouse",
  currency: "USD",
  locale: "en-US",
  timezone: "America/New_York",
};

/** How often the sample store is read again, as webhooks keep a real one current. */
export const SYNC_EVERY_MIN = 15;
/** When the sample store was last read, as of `now`: the latest quarter hour on the clock. */
export const lastSync = (now: number) => new Date(now - (now % (SYNC_EVERY_MIN * 60_000))).toISOString();
export const DAYS = 30;
/** Stock under this is low, the same line the store's own alert would draw. */
export const LOW_STOCK = 10;

export type Variant = { product: string; option?: string; category: string; price: number; stock: number };

export const VARIANTS: Variant[] = [
  { product: "Classic Tee", option: "M", category: "Tops", price: 24, stock: 4 },
  { product: "Classic Tee", option: "L", category: "Tops", price: 24, stock: 18 },
  { product: "Canvas Tote", category: "Bags", price: 32, stock: 7 },
  { product: "Ceramic Mug", option: "White", category: "Home", price: 18, stock: 9 },
  { product: "Ceramic Mug", option: "Black", category: "Home", price: 18, stock: 26 },
  { product: "Linen Shirt", option: "M", category: "Tops", price: 58, stock: 14 },
  { product: "Linen Shirt", option: "L", category: "Tops", price: 58, stock: 0 },
  { product: "Denim Jacket", option: "L", category: "Outerwear", price: 96, stock: 11 },
  { product: "Wool Beanie", category: "Accessories", price: 22, stock: 40 },
];

// Fifteen and eight share no factor, so every pairing comes up before any repeats.
const FIRST = [
  "Priya",
  "Aman",
  "Sara",
  "Rahul",
  "Neha",
  "Arjun",
  "Kavya",
  "Rohan",
  "Ishita",
  "Vikram",
  "Ananya",
  "Zoya",
  "Dev",
  "Meera",
  "Kabir",
];
const LAST = ["Sharma", "Kumar", "Iqbal", "Verma", "Gupta", "Mehta", "Nair", "Das"];
const CITIES = ["Brooklyn", "Austin", "Seattle", "Denver", "Chicago", "Portland", "Boston"];
const PEOPLE = 44;

export type Payment = "paid" | "pending" | "refunded";
export type Line = { variant: number; qty: number };
export type Order = {
  number: number;
  customer: string;
  daysAgo: number;
  lines: Line[];
  total: number;
  payment: Payment;
  /** Handed to the courier. A pending order is not sent until it is paid. */
  sent: boolean;
};

const person = (k: number) => `${FIRST[k % FIRST.length]} ${LAST[k % LAST.length]}`;
const priced = (lines: Line[]) => lines.reduce((sum, l) => sum + VARIANTS[l.variant].price * l.qty, 0);

function build(): Order[] {
  const out: Omit<Order, "number">[] = [];
  let i = 0;
  // Oldest first, so order numbers climb with time.
  for (let d = DAYS - 1; d >= 0; d--) {
    // A weekly rhythm: busier towards the weekend, quieter after it.
    const count = 5 + ((d * 3) % 4) + (d % 7 === 1 ? 3 : 0);
    for (let n = 0; n < count; n++, i++) {
      const lines: Line[] = [{ variant: (i * 5) % VARIANTS.length, qty: i % 3 === 0 ? 2 : 1 }];
      if (i % 4 === 0) lines.push({ variant: (i * 3 + 1) % VARIANTS.length, qty: 1 });
      const recent = d <= 1;
      const payment: Payment = recent && i % 5 === 1 ? "pending" : i % 23 === 0 ? "refunded" : "paid";
      out.push({
        customer: person((i * 37) % PEOPLE),
        daysAgo: d,
        lines,
        total: priced(lines),
        payment,
        sent: payment !== "pending" && !(recent && i % 4 === 2),
      });
    }
  }
  const first = 1043 - out.length;
  return out.map((o, k) => ({ ...o, number: first + k })).reverse();
}

/** Newest first. */
export const ORDERS: Order[] = build();

export type ReturnStage = "Requested" | "Received" | "Refunded";
const REASONS = ["Too small", "Changed my mind", "Arrived damaged", "Not as pictured"];

export function variantName(v: Variant) {
  return v.option ? `${v.product} / ${v.option}` : v.product;
}

/** The code on the shelf label: one per variant, in the order they are listed. */
export const sku = (v: Variant) => `BC-${101 + VARIANTS.indexOf(v)}`;

/** Where a customer ships to, the same every time their name comes up. */
export const cityOf = (name: string) => CITIES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % CITIES.length];

/** Every refund is a return that finished; a few recent orders are still on their way back. */
export const RETURNS: Array<{ order: Order; item: string; reason: string; stage: ReturnStage }> = ORDERS.flatMap(
  (o, k) => {
    const stage: ReturnStage | null =
      o.payment === "refunded"
        ? "Refunded"
        : o.payment === "paid" && o.sent && k % 17 === 3 && o.daysAgo < 12
          ? k % 2
            ? "Received"
            : "Requested"
          : null;
    return stage
      ? [{ order: o, item: variantName(VARIANTS[o.lines[0].variant]), reason: REASONS[k % REASONS.length], stage }]
      : [];
  }
);

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdShort = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** $4,120.50 with cents, $4,121 whole, or $4.1K short. */
export const money = (n: number, style: "cents" | "whole" | "short" = "whole") =>
  (style === "cents" ? usd : style === "short" ? usdShort : usdWhole).format(n);

const collected = (orders: Order[]) => orders.filter((o) => o.payment === "paid").reduce((s, o) => s + o.total, 0);

/** The variants under the low line, lowest first. */
export const LOW = VARIANTS.filter((v) => v.stock < LOW_STOCK).sort((a, b) => a.stock - b.stock);
/** Nothing left to sell: what the overview's "Stock to watch" lists. */
export const OUT = VARIANTS.filter((v) => v.stock <= 0);

/** Everyone who ordered, their orders newest first; busiest first, then most recent. Spent leaves out refunds. */
export const CUSTOMERS = [...new Set(ORDERS.map((o) => o.customer))]
  .map((name) => {
    const theirs = ORDERS.filter((o) => o.customer === name);
    return {
      name,
      orders: theirs,
      spent: theirs.filter((o) => o.payment !== "refunded").reduce((s, o) => s + o.total, 0),
    };
  })
  .sort((a, b) => b.orders.length - a.orders.length || b.orders[0].number - a.orders[0].number);

const yesterday = ORDERS.filter((o) => o.daysAgo === 1);

/** The figures the page quotes, each counted once. */
export const FIGURES = {
  collected: collected(ORDERS),
  refunded: ORDERS.filter((o) => o.payment === "refunded").reduce((s, o) => s + o.total, 0),
  thisWeek: collected(ORDERS.filter((o) => o.daysAgo < 7)),
  awaiting: ORDERS.filter((o) => o.payment === "pending").length,
  toSend: ORDERS.filter((o) => o.payment === "paid" && !o.sent).length,
  units: VARIANTS.reduce((s, v) => s + v.stock, 0),
  openReturns: RETURNS.filter((r) => r.stage !== "Refunded").length,
  yesterday: {
    orders: yesterday.length,
    collected: collected(yesterday),
    awaiting: yesterday.filter((o) => o.payment === "pending").length,
    toSend: yesterday.filter((o) => o.payment === "paid" && !o.sent).length,
  },
  /** Orders a day for the week that ended yesterday, oldest first. */
  week: Array.from({ length: 7 }, (_, k) => ORDERS.filter((o) => o.daysAgo === 7 - k).length),
};

/** Somebody worth looking up: whoever placed the newest order still waiting to be paid. */
export const FOLLOW_UP = CUSTOMERS.find((c) => c.orders[0].payment === "pending") ?? CUSTOMERS[0];

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** A count as a sentence says it: "three", or 14. */
export const spell = (n: number) => SMALL[n] ?? String(n);
export const Spell = (n: number) => spell(n).replace(/^\w/, (c) => c.toUpperCase());
