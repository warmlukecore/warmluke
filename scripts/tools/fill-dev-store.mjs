// Fills a Shopify development store with a shop's worth of made-up data:
// products stocked at its locations, customers, and orders spread back
// over months. Written into Shopify, not into our database, so the app
// takes it in the way it takes in any store's: webhooks, and "Check".
//
// Development stores only: it asks Shopify, and refuses anything else.
// Shopify lets a development store make five orders a minute, so orders
// are the slow part (300 is about an hour). It resumes: what it made
// is kept in the state file, and a second run carries on from there.
//
// Credentials come from a Dev Dashboard app in the same organization as
// the store, installed on it, with write_products, write_customers,
// write_orders, write_inventory and read_locations. In .env.seed.local:
//   SHOPIFY_SEED_SHOP=warmluke-dev.myshopify.com
//   SHOPIFY_SEED_CLIENT_ID=...
//   SHOPIFY_SEED_CLIENT_SECRET=...
//
//   node scripts/tools/fill-dev-store.mjs --products 100 --customers 600 --orders 300 [--days 120]

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const WANT = { products: +arg("products", 0), customers: +arg("customers", 0), orders: +arg("orders", 0) };
const DAYS = +arg("days", 120);
const env = Object.fromEntries(
  readFileSync(arg("env", ".env.seed.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const SHOP = env.SHOPIFY_SEED_SHOP ?? "";
if (!/^[a-z0-9-]+\.myshopify\.com$/.test(SHOP)) throw new Error("SHOPIFY_SEED_SHOP is not a myshopify address");
// Beside the env file and ignored with it (.env* in .gitignore).
const STATE_FILE = arg("state", `.env.seed.state.${SHOP.split(".")[0]}.json`);
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { products: [], customers: [], orders: 0 };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));

// ── Shopify ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grant = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.SHOPIFY_SEED_CLIENT_ID ?? "",
    client_secret: env.SHOPIFY_SEED_CLIENT_SECRET ?? "",
  }),
});
if (!grant.ok) throw new Error(`no token from ${SHOP}: ${grant.status} ${await grant.text()}`);
// Good for a day; a full run is a few hours.
const TOKEN = (await grant.json()).access_token;

async function gql(query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${SHOP}/admin/api/2026-07/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const body = res.status === 429 ? null : await res.json().catch(() => null);
    const throttled = res.status === 429 || body?.errors?.some?.((e) => e.extensions?.code === "THROTTLED");
    if (throttled || res.status >= 500) {
      if (attempt > 8) throw new Error(`gave up after ${attempt} tries (${res.status})`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!body || body.errors) throw new Error(`${res.status} ${JSON.stringify(body?.errors ?? body)}`);
    return body.data;
  }
}
/** What a mutation refused, if anything. */
const refused = (payload) =>
  (payload?.userErrors ?? []).map((e) => `${e.field?.join(".") ?? ""} ${e.message}`).join("; ");

const { shop, locations } = await gql(
  `{ shop { name currencyCode plan { partnerDevelopment } } locations(first: 10) { nodes { id name } } }`
);
if (!shop.plan.partnerDevelopment) throw new Error(`${SHOP} is not a development store; this only fills those`);
const CUR = shop.currencyCode;
const LOCS = locations.nodes.map((l) => l.id);
console.log(
  `${shop.name} (${SHOP}), ${CUR}, ${LOCS.length} locations; made so far: ${state.products.length} products, ${state.customers.length} customers, ${state.orders} orders`
);

// ── What gets made: the same every run, so a resumed run agrees ──
let seed = 20260925;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const money = (n) => n.toFixed(2);

const PHONES = [
  "iPhone 16",
  "iPhone 16 Pro",
  "iPhone 15",
  "iPhone 14",
  "Galaxy S25",
  "Galaxy S24",
  "Galaxy A55",
  "Pixel 9",
  "Pixel 8a",
  "OnePlus 13",
];
const models = () => PHONES.slice(between(0, 5)).slice(0, between(3, 5));
const first = (xs, lo, hi) => () => xs.slice(0, between(lo, hi));
const COLORS = ["Black", "White", "Navy", "Sage", "Blush", "Clear", "Graphite", "Sand", "Red", "Lavender"];
// ponytail: one made-up accessories shop; a different kind of shop is a different list here.
const CATEGORIES = [
  {
    type: "Phone Case",
    weight: 30,
    vendor: ["Carefone", "Armorix"],
    styles: [
      "Matte Silicone",
      "Clear Armor",
      "Leather Folio",
      "MagSafe Clear",
      "Carbon Fibre",
      "Rugged Dual-Layer",
      "Liquid Silicone",
      "Glitter",
      "Wallet",
      "Slim Grip",
    ],
    option: "Model",
    values: models,
    price: [18, 49],
  },
  {
    type: "Screen Protector",
    weight: 15,
    vendor: ["Carefone", "ClearCo"],
    styles: ["Tempered Glass", "Privacy Glass", "Matte Anti-Glare", "Edge-to-Edge", "Camera Lens Guard"],
    option: "Model",
    values: models,
    price: [9, 29],
  },
  {
    type: "Charger",
    weight: 12,
    vendor: ["Voltix", "Carefone"],
    styles: [
      "USB-C Wall Charger",
      "GaN Fast Charger",
      "Dual-Port Charger",
      "Wireless Charging Pad",
      "3-in-1 Charging Stand",
      "Car Charger",
    ],
    option: "Power",
    values: first(["20W", "35W", "65W"], 1, 3),
    price: [15, 59],
  },
  {
    type: "Cable",
    weight: 12,
    vendor: ["Voltix", "Carefone"],
    styles: [
      "Braided USB-C Cable",
      "USB-C to Lightning Cable",
      "Right-Angle USB-C Cable",
      "Magnetic Cable",
      "Coiled Cable",
    ],
    option: "Length",
    values: first(["1m", "2m", "3m"], 2, 3),
    price: [8, 25],
  },
  {
    type: "Earbuds",
    weight: 8,
    vendor: ["Soundly"],
    styles: ["True Wireless Earbuds", "Noise-Cancelling Earbuds", "Sport Earbuds", "Open-Ear Buds"],
    option: "Color",
    values: first(["Black", "White", "Sage"], 1, 3),
    price: [29, 129],
  },
  {
    type: "Power Bank",
    weight: 8,
    vendor: ["Voltix"],
    styles: ["Slim Power Bank", "MagSafe Power Bank", "Rugged Power Bank", "Laptop Power Bank"],
    option: "Capacity",
    values: first(["5000mAh", "10000mAh", "20000mAh"], 1, 3),
    price: [25, 89],
  },
  {
    type: "Watch Strap",
    weight: 8,
    vendor: ["Carefone", "Strapline"],
    styles: ["Sport Loop", "Silicone Band", "Milanese Loop", "Leather Strap", "Nylon Weave"],
    option: "Size",
    values: first(["41mm", "45mm", "49mm"], 2, 3),
    price: [12, 45],
  },
  {
    type: "Mount",
    weight: 7,
    vendor: ["Gripz"],
    styles: ["Car Vent Mount", "MagSafe Car Mount", "Bike Mount", "Desk Stand", "Tripod Grip"],
    option: null,
    values: () => ["Default Title"],
    price: [14, 39],
  },
];
const weighted = CATEGORIES.flatMap((c) => Array(c.weight).fill(c));
// Names that already say what they are ("USB-C Wall Charger") are not followed by the type again.
const SAYS_ITSELF = new Set(["Charger", "Cable", "Earbuds", "Power Bank", "Mount"]);

function planProducts(n) {
  const out = [];
  const seen = new Map();
  while (out.length < n) {
    const c = pick(weighted);
    const title = `${pick(c.styles)}${SAYS_ITSELF.has(c.type) ? "" : ` ${c.type}`}, ${pick(COLORS)}`;
    // A name made twice is a second edition, not a copy.
    const times = (seen.get(title) ?? 0) + 1;
    seen.set(title, times);
    const base = between(c.price[0], c.price[1]) - 0.01;
    const stepUp = c.option === "Power" || c.option === "Capacity" ? 10 : 0;
    out.push({
      title: times === 1 ? title : `${title} (Edition ${times})`,
      type: c.type,
      vendor: pick(c.vendor),
      tags: [
        c.type.toLowerCase().replace(/ /g, "-"),
        ...(rand() < 0.15 ? ["bestseller"] : []),
        ...(rand() < 0.1 ? ["new"] : []),
      ],
      option: c.option ?? "Title",
      variants: c.values().map((value, i) => {
        const r = rand();
        return {
          value,
          price: base + i * stepUp,
          cost: Math.round(base * (0.3 + rand() * 0.15) * 100) / 100,
          // Mostly stocked; some low, a few out, so the stock views have something to say.
          stock: LOCS.map((_, li) =>
            r < 0.07 ? 0 : r < 0.17 ? between(1, 4) : li === 0 ? between(10, 150) : between(0, 30)
          ),
        };
      }),
    });
  }
  return out;
}

const FIRST = [
  "James",
  "Olivia",
  "Liam",
  "Emma",
  "Noah",
  "Ava",
  "Ethan",
  "Sophia",
  "Mason",
  "Isabella",
  "Lucas",
  "Mia",
  "Aiden",
  "Harper",
  "Elijah",
  "Amelia",
  "Logan",
  "Evelyn",
  "Jackson",
  "Abigail",
  "Mateo",
  "Ella",
  "Daniel",
  "Grace",
  "Priya",
  "Arjun",
  "Wei",
  "Mei",
  "Carlos",
  "Sofia",
  "Omar",
  "Layla",
];
const LAST = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Lee",
  "Walker",
  "Hall",
  "Young",
  "King",
  "Wright",
  "Lopez",
  "Hill",
  "Scott",
  "Green",
  "Patel",
  "Shah",
  "Chen",
  "Nguyen",
  "Kim",
  "Khan",
];
const CITIES = [
  ["New York", "NY", "10001"],
  ["Brooklyn", "NY", "11201"],
  ["Los Angeles", "CA", "90012"],
  ["San Francisco", "CA", "94103"],
  ["Chicago", "IL", "60601"],
  ["Austin", "TX", "78701"],
  ["Houston", "TX", "77002"],
  ["Miami", "FL", "33101"],
  ["Seattle", "WA", "98101"],
  ["Boston", "MA", "02108"],
  ["Denver", "CO", "80202"],
  ["Atlanta", "GA", "30303"],
  ["Phoenix", "AZ", "85004"],
  ["Philadelphia", "PA", "19103"],
  ["Portland", "OR", "97204"],
];
function planCustomers(n) {
  return Array.from({ length: n }, (_, i) => {
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const [city, provinceCode, zip] = pick(CITIES);
    return {
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${i + 1}@example.com`.toLowerCase(),
      tags: rand() < 0.05 ? ["wholesale"] : rand() < 0.08 ? ["vip"] : [],
      address: {
        address1: `${between(10, 999)} ${pick(["Main", "Oak", "Maple", "Pine", "Cedar", "Elm", "Park"])} St`,
        city,
        provinceCode,
        countryCode: "US",
        zip,
      },
    };
  });
}

const CODES = [
  ["WELCOME10", 10],
  ["FALL15", 15],
  ["VIP20", 20],
];
function planOrders(n, now = Date.now()) {
  // More orders lately than months ago, and more at weekends.
  const weight = Array.from({ length: DAYS }, (_, d) => {
    const weekday = new Date(now - d * 86_400_000).getUTCDay();
    return (1 + (DAYS - d) / DAYS) * (weekday === 0 || weekday === 6 ? 1.3 : 1);
  });
  const total = weight.reduce((a, b) => a + b, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let x = rand() * total;
    let d = 0;
    while (d < DAYS - 1 && (x -= weight[d]) > 0) d++;
    const cod = rand() < 0.2;
    out.push({
      placed: Math.min(now - d * 86_400_000 - between(0, 20 * 3600) * 1000, now - 60_000),
      guest: rand() < 0.15,
      buyer: rand(),
      lines: Array.from({ length: rand() < 0.6 ? 1 : rand() < 0.75 ? 2 : 3 }, () => ({
        product: rand(),
        variant: rand(),
        qty: rand() < 0.85 ? 1 : between(2, 3),
      })),
      code: rand() < 0.15 ? pick(CODES) : null,
      pay: cod ? "PENDING" : "PAID",
      shipped: d > 6 ? rand() < 0.95 : d > 1 ? rand() < 0.6 : rand() < 0.1,
      delivered: d > 6,
      tracking: `1Z${between(100000, 999999)}${between(1000, 9999)}`,
    });
  }
  // Oldest first, so order numbers climb with the dates.
  return out.toSorted((a, b) => a.placed - b.placed);
}

// ── Make it ─────────────────────────────────────────────────────
const productPlan = planProducts(WANT.products);
for (let i = state.products.length; i < productPlan.length; i++) {
  const p = productPlan[i];
  const data = await gql(
    `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) {
      product { id variants(first: 10) { nodes { id price } } } userErrors { field message } } }`,
    {
      input: {
        title: p.title,
        productType: p.type,
        vendor: p.vendor,
        tags: p.tags,
        status: "ACTIVE",
        productOptions: [{ name: p.option, values: p.variants.map((v) => ({ name: v.value })) }],
        variants: p.variants.map((v, vi) => ({
          optionValues: [{ optionName: p.option, name: v.value }],
          price: money(v.price),
          sku: `CF-${String(i + 1).padStart(4, "0")}-${vi + 1}`,
          inventoryItem: { tracked: true, cost: money(v.cost) },
          inventoryQuantities: LOCS.map((locationId, li) => ({ locationId, name: "available", quantity: v.stock[li] })),
        })),
      },
    }
  );
  const why = refused(data.productSet);
  if (why) throw new Error(`product ${i + 1} "${p.title}": ${why}`);
  state.products.push(data.productSet.product.variants.nodes.map((v) => [v.id, Number(v.price)]));
  if ((i + 1) % 50 === 0 || i + 1 === productPlan.length) {
    save();
    console.log(`products ${i + 1}/${productPlan.length}`);
  }
}
save();

const customerPlan = planCustomers(WANT.customers);
for (let i = state.customers.length; i < customerPlan.length; i++) {
  const c = customerPlan[i];
  const data = await gql(
    `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
    {
      input: {
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        tags: c.tags,
        addresses: [{ ...c.address, firstName: c.firstName, lastName: c.lastName }],
      },
    }
  );
  const why = refused(data.customerCreate);
  if (why) throw new Error(`customer ${i + 1} ${c.email}: ${why}`);
  state.customers.push([data.customerCreate.customer.id, c]);
  if ((i + 1) % 50 === 0 || i + 1 === customerPlan.length) {
    save();
    console.log(`customers ${i + 1}/${customerPlan.length}`);
  }
}
save();

const orderPlan = planOrders(WANT.orders);
if (orderPlan.length && (!state.products.length || !state.customers.length)) {
  throw new Error("orders need products and customers made first");
}
// A few buyers come back often and a few products sell most; the rest trail off.
const buyer = (x) => state.customers[Math.floor(x ** 2.2 * state.customers.length)];
const product = (x) => state.products[Math.floor(x ** 1.8 * state.products.length)];
for (let i = state.orders; i < orderPlan.length; i++) {
  const o = orderPlan[i];
  const who = o.guest ? null : buyer(o.buyer);
  const lines = o.lines.map((l) => {
    const variants = product(l.product);
    const [variantId, price] = variants[Math.floor(l.variant * variants.length)];
    return { variantId, quantity: l.qty, price };
  });
  const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const person = who?.[1] ?? {
    firstName: "Guest",
    lastName: "Buyer",
    address: { address1: "1 Market St", city: "Chicago", provinceCode: "IL", countryCode: "US", zip: "60601" },
  };
  const order = {
    processedAt: new Date(o.placed).toISOString(),
    currency: CUR,
    ...(who ? { customer: { toAssociate: { id: who[0] } } } : { email: `guest.${i + 1}@example.com` }),
    lineItems: lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
    shippingAddress: { ...person.address, firstName: person.firstName, lastName: person.lastName },
    shippingLines: [
      {
        title: subtotal >= 50 ? "Free shipping" : "Standard",
        priceSet: { shopMoney: { amount: subtotal >= 50 ? "0.00" : "5.99", currencyCode: CUR } },
      },
    ],
    financialStatus: o.pay,
    ...(o.code ? { discountCode: { itemPercentageDiscountCode: { code: o.code[0], percentage: o.code[1] } } } : {}),
    tags: o.pay === "PENDING" ? ["cod"] : [],
    ...(o.shipped
      ? {
          fulfillment: {
            locationId: LOCS[0],
            trackingNumber: o.tracking,
            shipmentStatus: o.delivered ? "DELIVERED" : "IN_TRANSIT",
            notifyCustomer: false,
          },
        }
      : {}),
  };
  for (let attempt = 0; ; attempt++) {
    const data = await gql(
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }`,
      { order, options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false } }
    );
    const why = refused(data.orderCreate);
    if (!why) {
      state.orders = i + 1;
      save();
      console.log(
        `orders ${i + 1}/${orderPlan.length} ${data.orderCreate.order.name} ${order.processedAt.slice(0, 10)}`
      );
      break;
    }
    // Five a minute on a development store: wait the minute out and go again.
    if (/limit|exceed|too many|throttl/i.test(why) && attempt < 20) {
      await sleep(61_000);
      continue;
    }
    throw new Error(`order ${i + 1}: ${why}`);
  }
  // Paced under five a minute, so the limit is rarely met at all.
  await sleep(12_500);
}
console.log(`done: ${state.products.length} products, ${state.customers.length} customers, ${state.orders} orders`);
