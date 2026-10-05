// The tryout's scenarios on a real model (lib/scenarios.ts, 5 Oct): for
// designs that do what the owner said, every scenario goes through (no
// false alarm); for designs with a break the owner would meet, a scenario
// catches it. Written from the owner's own words, Hinglish included.
//
// Model tier, by hand, never CI: every case is a paid call. Prints each
// scenario, how it played and what it cost, and stops before --max-usd.
//
//   (set -a; . ./.env.anthropic.local; set +a; ANTHROPIC_TRYOUT_MODEL=claude-sonnet-5 \
//    node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-scenario-eval.mjs --max-usd 0.3)

import { tryoutModel } from "../src/lib/ai.ts";
import { keyFor } from "../src/lib/model-tape.ts";
import { dollars, priceOf } from "../src/lib/model-prices.ts";
import { describeForScenarios, playDay, writeScenarios } from "../src/lib/scenarios.ts";
import { metered } from "../src/lib/usage.ts";

const model = tryoutModel();
if (!model || !keyFor(process.env.ANTHROPIC_API_KEY)) {
  console.log("ANTHROPIC_TRYOUT_MODEL and ANTHROPIC_API_KEY are both needed; nothing checked");
  process.exit(0);
}
if (!priceOf(model)) {
  console.log(`${model} has no price, so no cap can be held; nothing checked`);
  process.exit(1);
}
const at = process.argv.indexOf("--max-usd");
const cap = at > 0 ? Number(process.argv[at + 1]) : 0.3;
/** A case counted before it is made: one call, a design in and a few scenarios out. */
const GUESS = 0.03;

// ── The sections ─────────────────────────────────────────────
const ORDERS = {
  name: "Orders",
  store: true,
  columns: [
    { field: "order_number", label: "Order", type: "text" },
    { field: "customer_name", label: "Customer", type: "text" },
    { field: "customer_phone", label: "Phone", type: "phone" },
    { field: "total", label: "Total", type: "currency" },
    { field: "gateway", label: "Payment", type: "badge" },
  ],
  rows: Array.from({ length: 6 }, (_, i) => ({
    id: `o-${i}`,
    order_number: `#${1040 + i}`,
    customer_name: ["Asha", "Ravi", "Meera", "Kabir", "Zoya", "Dev"][i],
    customer_phone: `+91 98${i}00 0000${i}`,
    total: 600 + i * 150,
    gateway: i % 2 ? "Prepaid" : "Cash on Delivery (COD)",
  })),
};
const targetOf = (l) => (l === "m-orders" ? ORDERS : null);
const section = (name, columns, features, rows = []) => ({
  plan: 0,
  name,
  columns,
  features,
  rows,
  storeFields: new Set(),
  fresh: new Set(),
});
const link = { field: "order", label: "Order", type: "link", linkTo: "m-orders" };
const is = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });
const isnt = (field, value) => ({ op: "!=", args: [{ field }, { const: value }] });

const returns = (reasons, actions, statuses = ["Requested", "Received", "Refunded"]) =>
  section(
    "Returns",
    [
      link,
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "reason", label: "Reason", type: "dropdown" },
      { field: "status", label: "Status", type: "badge" },
    ],
    {
      filters: [
        { field: "reason", label: "Reason", options: reasons },
        { field: "status", label: "Status", options: statuses },
      ],
      actions,
      stats: [{ label: "Waiting to arrive", op: "count", where: is("status", "Requested") }],
    },
    [{ customer_name: "Meera", reason: reasons[0], status: statuses.at(-1) }]
  );
/** A new return starts as Requested, as a real design sets it: without it the Received button never shows. */
const startsRequested = [
  { name: "New returns start Requested", on: "record_created", set: { status: { const: "Requested" } } },
];
const received = { label: "Received", set: { status: { const: "Received" } }, when: is("status", "Requested") };
const refunded = { label: "Refunded", set: { status: { const: "Refunded" } }, when: is("status", "Received") };

const cod = (countAs) =>
  section(
    "COD calls",
    [
      link,
      { field: "customer_phone", label: "Phone", type: "phone" },
      { field: "call_status", label: "Call status", type: "badge" },
      { field: "attempts", label: "Calls made", type: "number" },
    ],
    {
      filters: [
        {
          field: "call_status",
          label: "Call status",
          options: ["Pending", "Confirmed", "Cancelled", "Not reachable"],
        },
      ],
      actions: [
        { label: "Confirmed", set: { call_status: { const: "Confirmed" } }, when: isnt("call_status", "Confirmed") },
        {
          label: "Not reachable",
          set: {
            call_status: { const: "Not reachable" },
            attempts: { op: "+", args: [{ field: "attempts" }, { const: 1 }] },
          },
        },
      ],
      stats: [{ label: "To call", op: "count", where: is("call_status", countAs) }],
    },
    [{ customer_phone: "+91 98000 11111", call_status: "Confirmed", attempts: 1 }]
  );

const rto = (filters) =>
  section(
    "RTO tracker",
    [
      link,
      { field: "courier", label: "Courier", type: "dropdown" },
      { field: "rto", label: "RTO", type: "boolean" },
      { field: "reason", label: "Reason", type: "text" },
    ],
    { filters },
    [{ courier: "Delhivery", rto: true, reason: "Customer refused" }]
  );

const restock = section(
  "Restock",
  [
    { field: "product", label: "Product", type: "text" },
    { field: "on_hand", label: "On hand", type: "number" },
    { field: "status", label: "Status", type: "badge" },
  ],
  {
    filters: [{ field: "status", label: "Status", options: ["To order", "Ordered", "Arrived"] }],
    actions: [
      { label: "Ordered", set: { status: { const: "Ordered" } }, when: is("status", "To order") },
      { label: "Arrived", set: { status: { const: "Arrived" } }, when: is("status", "Ordered") },
    ],
    stats: [{ label: "To order", op: "count", where: is("status", "To order") }],
  },
  [{ product: "Silk saree", on_hand: 3, status: "To order" }]
);

const CASES = [
  {
    name: "returns that work",
    broken: false,
    words:
      "returns ka log chahiye: order chuno, customer aa jaaye, reason size ya damaged, packing team jab parcel aaye to received mark kare, aur dikhe kitne aane baaki hain",
    s: returns(["Size", "Damaged"], [received, refunded]),
    rules: startsRequested,
  },
  {
    name: "returns missing the reason they named",
    broken: true,
    words: "returns log karna hai, reason size, damaged ya wrong item hota hai, sabse zyada wrong item aata hai",
    s: returns(["Size", "Damaged"], [received]),
    rules: startsRequested,
  },
  {
    name: "returns without the Received they mark",
    broken: true,
    words: "return request log ho, aur jab parcel warehouse pahunche packing team received mark kare",
    // Neither a Received button nor a Received status: nothing on the design marks it.
    s: returns(["Size", "Damaged"], [refunded], ["Requested", "Refunded"]),
    rules: startsRequested,
  },
  {
    name: "COD calls that work",
    broken: false,
    words:
      "COD orders pe call karke confirm karna hai dispatch se pehle. Pending, confirmed, cancelled ya not reachable, kitni baar call kiya, aur kitne call karne baaki hain dikhe",
    s: cod("Pending"),
  },
  {
    name: "COD counter that never moves",
    broken: true,
    words: "COD orders confirm karne hain, har order pending se shuru, aur upar dikhe kitne call karne baaki hain",
    s: cod("pending "),
  },
  {
    name: "RTO tracker without the RTO filter",
    broken: true,
    words: "RTO wale orders track karne hain, courier aur reason ke saath, aur sirf RTO wale alag dikhne chahiye",
    s: rto([{ field: "courier", label: "Courier", options: ["Delhivery", "Shiprocket"] }]),
  },
  {
    name: "RTO tracker that works",
    broken: false,
    words: "RTO orders track karne hain, courier aur reason ke saath, aur sirf RTO wale alag dikhne chahiye",
    s: rto([
      { field: "rto", label: "RTO", options: ["Yes", "No"] },
      { field: "courier", label: "Courier", options: ["Delhivery", "Shiprocket"] },
    ]),
  },
  {
    name: "restock that works",
    broken: false,
    words:
      "jo product khatam ho raha hai uska reorder list, ordered mark karu, aur jab maal aaye arrived, upar dikhe kitne order karne hain",
    s: restock,
  },
];

let spent = 0;
const results = [];
for (const c of CASES) {
  if (spent + GUESS > cap) {
    console.log(`\nstopped before ${c.name}: ${dollars(spent)} spent of ${dollars(cap)}`);
    break;
  }
  const t0 = Date.now();
  const [written, usage] = await metered(() =>
    writeScenarios({
      ownerWords: c.words,
      understood: "",
      sections: [describeForScenarios(c.s, targetOf, c.rules ?? [])],
      model,
    })
  );
  const u = usage();
  spent += u?.usd ?? GUESS;
  const played = playDay([{ s: c.s, rules: c.rules ?? [] }], written, targetOf);
  const failed = played.filter((p) => p.ok === false);
  const right = c.broken ? failed.length > 0 : failed.length === 0 && played.some((p) => p.ok);
  results.push({ ...c, right, played });
  console.log(
    `\n${right ? "ok  " : "MISS"}  ${c.name} (${c.broken ? "broken" : "works"})  ${written.length} scenarios, ${Date.now() - t0}ms, ${u ? dollars(u.usd) : "no usage"}`
  );
  for (const p of played)
    console.log(
      `        ${p.ok ? "went through" : p.ok === null ? "not tried" : "STOPPED"}: ${p.title}${p.ok ? "" : ` — ${p.why}`}${(p.notes ?? []).map((n) => `\n          note: ${n}`).join("")}`
    );
}

const broken = results.filter((r) => r.broken);
const fine = results.filter((r) => !r.broken);
console.log(
  `\ncaught ${broken.filter((r) => r.right).length} of ${broken.length} broken designs; ${fine.filter((r) => !r.right).length} false alarms on ${fine.length} that work`
);
console.log(`spent ${dollars(spent)} on ${model}`);
process.exit(results.every((r) => r.right) ? 0 : 1);
