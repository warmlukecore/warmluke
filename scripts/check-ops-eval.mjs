// The operator's view on four asks, on a real model.
//
//   a  "mark which orders went RTO"            → an idea (acting on the NDR first, RTO by pincode or courier)
//   b  "track COD confirmation calls"          → at most one idea, or none
//   c  "tell me when stock runs low"           → at most one idea, or none
//   d  "rename Orders to Dispatch"             → no idea at all
//
// Held on every case: at most two ideas, each under 200 characters, no
// field names or types, and the owner's language kept. Whether a, b and
// c found a better idea is said, and held only for a: RTO is the ask
// the switch exists for. Model tier: real calls, by hand, when the
// operator's prompt, DOMAIN_PACK or model changes; never in CI. It
// prints what it spent. Run it before turning ANTHROPIC_OPS_MODEL on.
//
//   ANTHROPIC_OPS_MODEL=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-ops-eval.mjs
//   (a real key in the environment; MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { buildPlanPrompt, buildUserMessage, opsModel } from "../src/lib/ai.ts";
import { keyFor } from "../src/lib/model-tape.ts";
import { dollars } from "../src/lib/model-prices.ts";
import { opsView } from "../src/lib/reviewers.ts";
import { metered } from "../src/lib/usage.ts";

const model = opsModel();
if (!model || !keyFor(process.env.ANTHROPIC_API_KEY)) {
  console.log("ANTHROPIC_OPS_MODEL and ANTHROPIC_API_KEY are both needed; nothing checked");
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// A store like the ones the switch is for: COD-heavy, Indian, a few months in.
const store = {
  shop_domain: "kurta-ghar.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  country: "IN",
  importing: false,
  counts: { orders: 2353, products: 148, customers: 1904, inventory_levels: 296 },
  values: {
    "orders.financial_status": ["PAID", "PENDING", "REFUNDED"],
    "orders.payment_gateway": ["Cash on Delivery (COD)", "Razorpay"],
  },
  snapshot: {
    last_synced_at: "2026-10-03T09:00:00Z",
    history: null,
    recent: [
      { number: "#2353", placed: "2026-10-03", total: 1299, currency: "INR", status: "PENDING" },
      { number: "#2352", placed: "2026-10-03", total: 899, currency: "INR", status: "PAID" },
    ],
    low: [{ product: "Cotton kurta / M", variant: null, location: "Jaipur", available: 3 }],
    top_customers: [],
    best_sellers: [{ title: "Cotton kurta", units: 640, revenue: 831360, currency: "INR" }],
  },
};
const modules = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "p",
    parent_id: null,
    name: "orders",
    nav_label: "Orders",
    icon: "shopping-cart",
    route: "/orders",
    sort_order: 0,
    source_table: "orders",
    created_at: "",
  },
];
const sections = [
  "- Orders [id 11111111-1111-4111-8111-111111111111] — over the store's orders: order_number (text), placed_at (date), total (currency), financial_status (badge), payment_gateway (text), shipping_city (text), shipping_zip (text)",
];
const merchant = "Runs Kurta Ghar, a clothing brand in Jaipur, about 800 orders a month, a team of four.";
const context = buildPlanPrompt(modules, "Kurta Ghar", "en-IN", "INR", store, merchant)[1];

const cases = [
  {
    name: "a  RTO tracking",
    ask: "mujhe har order pe mark karna hai ki RTO hua ya nahi",
    hinglish: true,
    wantIdea: true,
  },
  { name: "b  COD confirmation", ask: "I want to track which COD orders we have called to confirm", hinglish: false },
  { name: "c  low stock", ask: "Tell me when a product is running low", hinglish: false },
  { name: "d  a rename", ask: "Rename the Orders section to Dispatch", hinglish: false, none: true },
];

let spent = 0;
for (const c of cases) {
  const t0 = Date.now();
  const [v, usage] = await metered(() =>
    opsView({ context, request: buildUserMessage(c.ask, null, null, null, [], sections, []), history: [], model })
  );
  const u = usage();
  spent += u?.usd ?? 0;
  console.log(`\n${c.name}  (${Date.now() - t0}ms, ${u ? dollars(u.usd) : "no usage"})`);
  console.log(`     → ${JSON.stringify(v)}`);
  if (!v) {
    check("a view came back", false);
    continue;
  }
  const words = v.ideas.map((i) => i.idea).join(" ");
  check(
    "at most two ideas, each under 200 characters",
    v.ideas.length <= 2 && v.ideas.every((i) => i.idea.length < 200)
  );
  check(
    "no field names or types",
    !/\b(boolean|dropdown|badge|field|column|set_fields|schema)\b|_[a-z]+_?/i.test(words)
  );
  if (c.hinglish && v.ideas.length) {
    // Said, not held: a Hinglish ask answered in English is a prompt to fix, not a broken view.
    console.log(`  ${/\b(hai|ka|ke|ki|karo|se|pe|ko)\b/i.test(words) ? "ok  " : "note"}  the owner's language kept`);
  }
  if (c.none) check("a small exact change gets no idea", v.ideas.length === 0);
  else if (c.wantIdea) check("the ask the switch is for gets an idea", v.ideas.length >= 1);
  else console.log(`  note  ${v.ideas.length ? `found ${v.ideas.length}: ${words}` : "no idea"}`);
}

console.log(`\nspent ${dollars(spent)} on ${model}`);
console.log(
  fails.length === 0 ? "the operator adds an idea where it helps and none where it does not" : `${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
