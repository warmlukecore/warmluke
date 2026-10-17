// What each eval case expects, worked out from the very nodes its store was
// seeded with (scripts/fixtures/seed-shop.ts, business-shop.ts), so a change
// to a shop moves its answers with it instead of leaving a number in a JSON
// file to rot. A case names its expectation in `expect`; these are pure.
//
// - answer: what Luke's words must hold. `any` is one of several numbers
//   (a total with tax and postage, or the goods alone: both are honest
//   readings of "revenue"); `names` must all appear; `re` is a pattern.
// - effect: the rows a build must point at. Some field of the owner's (or a
//   worked-out one) marks exactly these rows, or a rule's dry run matches
//   that many, or a counter shows that many.
// - exercise: owner writes to make after the build, then the values the
//   expected rows must show. The only way to see an event rule work.
//
// Callers: scripts/eval-luke.mjs, scripts/check-eval-harness.mjs, scripts/check-eval-graders.mjs.

const money = (set) => Number(set?.shopMoney?.amount ?? 0);
const DAY = 86_400_000;

/**
 * A seeded shop's nodes as rows a case can count, with each order's age in
 * days; `shop` brings what its connections would (shipments, ad days, the
 * restock time), as business-shop.ts seeds them.
 */
export function viewOf(nodes, now, shop = {}) {
  const noon = Math.floor(now / DAY) * DAY + 6.5 * 3_600_000;
  const customers = new Map((nodes.customers ?? []).map((c) => [c.id, c]));
  const typeOf = new Map((nodes.products ?? []).map((p) => [p.id, p.productType]));
  const orders = (nodes.orders ?? []).map((o) => {
    const c = o.customer ? customers.get(o.customer.id) : null;
    const subtotal = money(o.currentSubtotalPriceSet);
    const discount = money(o.currentTotalDiscountsSet);
    return {
      number: o.name,
      daysBack: Math.round((noon - Date.parse(o.createdAt)) / DAY),
      cancelled: !!o.cancelledAt,
      pay: o.displayFinancialStatus,
      shipped: o.displayFulfillmentStatus === "FULFILLED",
      cod: /cod|cash/i.test((o.paymentGatewayNames ?? [])[0] ?? ""),
      total: money(o.totalPriceSet),
      subtotal,
      goods: subtotal - discount,
      discount,
      codes: o.discountCodes ?? [],
      campaign: o.customerJourneySummary?.lastVisit?.utmParameters?.campaign ?? null,
      customer: c ? { id: c.id, name: c.displayName, phone: c.phone } : null,
      lines: o.lineItems.nodes.map((l) => ({
        title: l.title,
        variant: l.variantTitle,
        sku: l.sku,
        qty: l.quantity,
        type: typeOf.get(l.product?.id) ?? null,
      })),
    };
  });
  const stock = new Map(
    (nodes.inventory ?? []).map((s) => [
      s.id,
      s.inventoryItem.inventoryLevels.nodes.reduce(
        (n, lv) => n + (lv.quantities.find((q) => q.name === "available")?.quantity ?? 0),
        0
      ),
    ])
  );
  const variants = (nodes.products ?? []).flatMap((p) =>
    p.variants.nodes.map((v) => ({
      product: p.title,
      status: p.status,
      type: p.productType,
      variant: v.title,
      sku: v.sku,
      available: stock.get(v.id) ?? 0,
    }))
  );
  return {
    orders,
    variants,
    customers: [...customers.values()],
    shipments: shop.shipments ?? [],
    ads: shop.ads ?? [],
    restockDays: shop.restockDays ?? null,
  };
}

const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
const live = (o) => !o.cancelled;
const inSet = (field, values) => (row) => values.includes(String(row?.[field] ?? ""));
const anyValueIn = (values) => (row) => Object.values(row ?? {}).some((v) => values.includes(String(v ?? "")));
/** The three readings of money an owner may mean: with tax and postage, the goods after discount, before it. */
const readings = (rows) => [sum(rows, (o) => o.total), sum(rows, (o) => o.goods), sum(rows, (o) => o.subtotal)];
const effectOn = (tables, field, values) => ({
  tables,
  match: inSet(field, values),
  count: values.length,
  labels: values,
});

/** RTO over the settled shipments sent `from`–`to` days back, as abo_rto_cohorts counts it, in one decimal. */
const rtoRate = (batches, from, to) => {
  const in_ = batches.filter((b) => b.daysBack >= from && b.daysBack <= to);
  const settled = sum(in_, (b) => b.n - (b.moving ?? 0));
  return Math.round((1000 * sum(in_, (b) => b.rto)) / settled) / 10;
};
/** Each variant's days of stock at its pace over the last 28 days, as abo_stock_cover counts them. */
const daysLeft = (v) => {
  const sold = new Map();
  for (const o of v.orders.filter((o) => live(o) && o.daysBack <= 27))
    for (const l of o.lines) sold.set(l.sku, (sold.get(l.sku) ?? 0) + l.qty);
  return v.variants
    .filter((x) => sold.get(x.sku) > 0)
    .map((x) => ({ ...x, left: Math.floor(x.available / (sold.get(x.sku) / 28)) }));
};

export const EXPECT = {
  // ── Store questions ────────────────────────────────────────
  "seed-cod-pending": (v) => {
    const due = v.orders.filter((o) => live(o) && o.cod && o.pay === "PENDING" && o.daysBack <= 6);
    return { answer: [{ label: "COD still to collect from the last 7 days", any: readings(due) }] };
  },
  "seed-discount-use": (v) => {
    const used = v.orders.filter((o) => live(o) && o.codes.includes("DIWALI10"));
    return {
      answer: [
        { label: "orders that used DIWALI10", any: [used.length] },
        { label: "discount given", any: [sum(used, (o) => o.discount)] },
      ],
    };
  },
  "cases-out-of-stock": (v) => {
    const byProduct = new Map();
    for (const x of v.variants.filter((x) => x.status === "ACTIVE"))
      byProduct.set(x.product, [...(byProduct.get(x.product) ?? []), x]);
    const out = [...byProduct].filter(([, xs]) => xs.every((x) => x.available <= 0)).map(([p]) => p);
    // The name a person says: its first two words ("Cherry Heart", "MagSafe Ring"), not the phone model.
    return {
      answer: [{ label: "products with nothing left", names: out.map((p) => p.split(" ").slice(0, 2).join(" ")) }],
    };
  },
  "fashion-top-size": (v) => {
    const qty = new Map();
    for (const o of v.orders.filter((o) => live(o) && o.daysBack <= 29))
      for (const l of o.lines.filter((l) => l.type === "Tee")) qty.set(l.variant, (qty.get(l.variant) ?? 0) + l.qty);
    const [size, n] = [...qty].toSorted((a, b) => b[1] - a[1])[0];
    const word = { S: "small", M: "medium", L: "large", XL: "extra large" }[size] ?? size;
    return {
      answer: [
        { label: `size ${size}`, re: `\\b(${size}|${word})\\b` },
        { label: `${n} tees in size ${size}`, any: [n] },
      ],
    };
  },
  // ── Investigations (the sprint's Days 9–11) ────────────────
  "ethnic-rto-why": (v) => {
    const cod = v.shipments.filter((b) => b.payment === "COD");
    return {
      answer: [
        { label: "RTO over the last 14 days", any: [rtoRate(v.shipments, 0, 13)] },
        { label: "against the 14 days before", any: [rtoRate(v.shipments, 14, 27)] },
        { label: "COD is where it rose", names: ["COD"] },
        { label: "COD's own rate", any: [rtoRate(cod, 0, 13)] },
      ],
    };
  },
  "ethnic-runs-out": (v) => {
    const short = daysLeft(v).filter((x) => x.left < v.restockDays);
    return {
      answer: [
        { label: "the product running out", names: [...new Set(short.map((x) => x.type))] },
        ...short.map((x) => ({ label: `${x.product} ${x.variant}: ${x.left} days`, any: [x.left] })),
      ],
    };
  },
  "ethnic-ads-stock": (v) => {
    const short = new Set(
      daysLeft(v)
        .filter((x) => x.left < v.restockDays)
        .map((x) => x.sku)
    );
    const ad = v.ads.find((a) =>
      v.orders.some(
        (o) =>
          live(o) &&
          [a.name.toLowerCase(), a.id].includes(String(o.campaign ?? "").toLowerCase()) &&
          o.lines.some((l) => short.has(l.sku))
      )
    );
    return {
      answer: [
        { label: "the campaign spending on stock running out", names: [ad.name] },
        { label: "what it sells that is running out", names: ["Kurta"] },
      ],
    };
  },
  "cosmetics-week-vs-week": (v) => {
    const last = v.orders.filter((o) => live(o) && o.daysBack <= 6);
    const before = v.orders.filter((o) => live(o) && o.daysBack >= 7 && o.daysBack <= 13);
    return {
      answer: [
        { label: "the last 7 days", any: readings(last) },
        { label: "the 7 days before", any: readings(before) },
      ],
    };
  },
  "gadgets-big-cod": (v) => {
    const big = v.orders.filter((o) => live(o) && o.cod && o.daysBack <= 29 && o.goods > 5000);
    return {
      answer: [
        { label: "COD orders over 5,000", any: [big.length] },
        { label: "their total", any: readings(big) },
      ],
    };
  },
  "snacks-repeat-buyers": (v) => {
    const n = new Map();
    for (const o of v.orders.filter((o) => live(o) && o.customer))
      n.set(o.customer.id, (n.get(o.customer.id) ?? 0) + 1);
    return {
      answer: [{ label: "customers with more than 2 orders", any: [[...n.values()].filter((k) => k > 2).length] }],
    };
  },
  "wholesale-owed": (v) => {
    const owed = v.orders.filter((o) => live(o) && o.pay === "PENDING");
    return { answer: [{ label: "owed by B2B customers", any: readings(owed) }] };
  },
  "wholesale-top-customers": (v) => {
    const by = new Map();
    for (const o of v.orders.filter((o) => live(o) && o.customer && o.daysBack <= 89))
      by.set(o.customer.name, (by.get(o.customer.name) ?? 0) + o.total);
    const top = [...by].toSorted((a, b) => b[1] - a[1]).slice(0, 3);
    return { answer: [{ label: "the top 3 customers", names: top.map(([name]) => name) }] };
  },

  // ── What a build must point at ─────────────────────────────
  "snacks-repeat-cod": (v) => {
    const seen = new Set();
    const repeat = [];
    for (const o of v.orders.filter(live).toSorted((a, b) => b.daysBack - a.daysBack)) {
      if (o.cod && o.customer?.phone && seen.has(o.customer.phone)) repeat.push(o.number);
      if (o.customer?.phone) seen.add(o.customer.phone);
    }
    return { effect: effectOn(["orders"], "order_number", repeat) };
  },
  "fashion-late": (v) => ({
    effect: effectOn(
      ["orders"],
      "order_number",
      v.orders.filter((o) => live(o) && !o.shipped && o.daysBack > 2).map((o) => o.number)
    ),
  }),
  "gadgets-call-list": (v) => ({
    effect: effectOn(
      ["orders"],
      "order_number",
      v.orders.filter((o) => live(o) && o.cod && !o.shipped && o.goods > 5000).map((o) => o.number)
    ),
  }),
  "wholesale-overdue": (v) => ({
    effect: effectOn(
      ["orders"],
      "order_number",
      v.orders.filter((o) => live(o) && o.pay === "PENDING" && o.daysBack > 30).map((o) => o.number)
    ),
  }),
  "fashion-reorder": (v) => ({
    effect: effectOn(
      ["variants", "inventory_levels"],
      "sku",
      v.variants.filter((x) => x.available < 5).map((x) => x.sku)
    ),
  }),
  "cases-sku-twins": (v) => {
    const by = new Map();
    for (const x of v.variants) by.set(x.sku, [...(by.get(x.sku) ?? []), x]);
    const twins = [...by].filter(([, xs]) => xs.length > 1 && new Set(xs.map((x) => x.available)).size > 1);
    const skus = twins.map(([sku]) => sku);
    return {
      effect: {
        tables: ["variants", "inventory_levels"],
        match: inSet("sku", skus),
        count: twins.reduce((n, [, xs]) => n + xs.length, 0),
        labels: skus,
      },
    };
  },
  // The batches are the case's own rows (its `before`), not the shop's.
  "cosmetics-expiring": () => {
    const soon = ["VCS-2401", "HYA-2402"];
    return { effect: { own: "batch", match: anyValueIn(soon), count: soon.length, labels: soon } };
  },

  // ── Owner writes after the build, then what must show ──────
  "cases-blank": (v) => {
    const blank = v.variants.find((x) => x.type === "Blank");
    const children = [...new Set(v.variants.filter((x) => x.type === "Printed").map((x) => x.sku))];
    return {
      exercise: {
        steps: [
          {
            tag: {
              tables: ["variants", "inventory_levels"],
              match: inSet("sku", children),
              field: "blank|parent|base|material|made from",
              value: blank.sku,
            },
          },
          {
            add: {
              own: "blank|parent|base|material",
              values: [
                ["sku|code|blank|parent|name|item", blank.sku],
                ["count|stock|qty|quantit|units|available|remaining|left", 50],
              ],
            },
          },
        ],
        then: {
          tables: ["variants", "inventory_levels"],
          match: inSet("sku", children),
          // Set in the app, or read from the blank's own count in the store: either is the blank's number.
          equals: [50, blank.available],
          labels: children,
        },
      },
    };
  },
};

/** A case's expectation, worked out: `expect` names, resolved against the shop it runs on. */
export function expectationFor(c, view) {
  const e = c.expect ?? {};
  const out = {};
  for (const k of ["answer", "effect", "exercise"]) {
    if (!e[k]) continue;
    const f = EXPECT[e[k]];
    if (!f) throw new Error(`${c.id}: no expectation "${e[k]}"`);
    Object.assign(out, f(view));
  }
  return out;
}
