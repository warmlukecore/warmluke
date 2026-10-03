// A design's rules, run in the head (dry-run.ts): how many rows each
// would meet or change, of how many, said before it is built.
//
// Pure: no database (a stand-in that serves fixture rows for a section
// over the store, through abo_store_page as the app reads it, and for a
// section of the owner's, from records) and no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-dry-run.mjs

import { dryRunRules } from "../src/lib/dry-run.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// ── The store's shipments (2,353, past the 2,000 read), packing and returns of the owner's ──
const SHIPMENTS = Array.from({ length: 2353 }, (_, i) => ({
  id: `f-${i}`,
  data: {
    order_number: `#${1001 + i}`,
    customer_name: "Asha Rao",
    carrier: "Delhivery",
    tracking_number: "",
    shipment_status: i % 4 === 0 ? "Delivered" : "In Transit",
  },
}));
const PACKING = Array.from({ length: 25 }, (_, i) => ({ data: { item: `Mug ${i}`, packed: "Yes" } }));
const RETURNS = Array.from({ length: 30 }, (_, i) => ({
  data: { order: `#${1001 + i}`, status: i < 7 ? "Open" : "Closed", phone: "+91 98765 43210" },
}));
const CUSTOMERS = Array.from({ length: 22 }, (_, i) => ({
  id: `c-${i}`,
  data: { name: `Person ${i}`, phone: "+91 98765 43210", email: `p${i}@mail.test`, orders_count: i % 3 },
}));

/** A stand-in for the caller's client: what it was asked, and the fixture rows each section holds. */
function fakeDb({ fail = false, hang = false } = {}) {
  const asked = [];
  const store = { "m-ship": SHIPMENTS, "m-cust": CUSTOMERS };
  const own = { "m-pack": PACKING, "m-ret": RETURNS };
  const later = (v) => (hang ? new Promise(() => {}) : Promise.resolve(v));
  return {
    asked,
    db: {
      rpc(name, args) {
        asked.push({ rpc: name, ...args });
        if (fail) return later({ data: null, error: { message: "permission denied" } });
        const rows = store[args.p_module] ?? [];
        const { offset = 0, limit = 50 } = args.p_query;
        return later({
          data: { rows: rows.slice(offset, offset + Math.min(limit, 200)), total: rows.length, facets: {} },
          error: null,
        });
      },
      from(table) {
        const q = { table, filters: [] };
        asked.push(q);
        const b = {
          select: (cols, opts) => ((q.select = cols), (q.count = opts?.count), b),
          eq: (c, v) => (q.filters.push(["eq", c, v]), b),
          is: (c, v) => (q.filters.push(["is", c, v]), b),
          order: () => b,
          range: (from, to) => ((q.range = [from, to]), b),
          then: (ok, no) => {
            if (fail) return later({ data: null, error: { message: "permission denied" } }).then(ok, no);
            const rows = own[q.filters.find(([, c]) => c === "module_id")?.[2]] ?? [];
            const [from, to] = q.range ?? [0, 999];
            return later({ data: rows.slice(from, to + 1), count: q.count ? rows.length : null, error: null }).then(
              ok,
              no
            );
          },
        };
        return b;
      },
    },
  };
}

const MODULES = [
  { id: "m-ship", name: "shipments", nav_label: "Shipments", source_table: "fulfillments" },
  { id: "m-pack", name: "packing", nav_label: "Packing", source_table: null },
  { id: "m-ret", name: "returns", nav_label: "Returns", source_table: null },
  { id: "m-cust", name: "customers", nav_label: "Customers", source_table: "customers" },
];
const SCHEMAS = new Map([
  ["m-ship", { columns: [{ field: "rto", label: "RTO", type: "text" }] }],
  [
    "m-pack",
    {
      columns: [
        { field: "item", label: "Item", type: "text" },
        { field: "packed", label: "Packed", type: "text" },
      ],
    },
  ],
  [
    "m-ret",
    {
      columns: [
        { field: "phone", label: "Phone", type: "phone" },
        { field: "order", label: "Order", type: "text" },
        { field: "status", label: "Status", type: "badge" },
      ],
    },
  ],
  ["m-cust", { columns: [] }],
]);
const ctxOf = (db, more = {}) => ({
  db,
  projectId: "p-1",
  store: null,
  modules: MODULES,
  schemas: SCHEMAS,
  ownerWords: "",
  understood: "",
  locale: "en-IN",
  currency: "INR",
  uxModel: null,
  ...more,
});
const rule = (target, name, trigger, actions) => ({
  changeType: "AUTOMATION_ADD",
  targetModuleId: target,
  newModule: null,
  newSchema: { columns: [] },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: { name, definition: { trigger, actions } },
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
});
const eq = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });
const hourly = { type: "schedule", every: "hourly" };

const plans = [
  rule("m-ship", "Mark RTO no", hourly, [
    { type: "set_fields", target: { self: true }, set: { rto: { const: "No" } } },
  ]),
  rule(
    "#Shipments",
    "Delivered alert",
    { type: "schedule", every: "daily", when: eq("shipment_status", "Delivered") },
    [{ type: "alert", title: "Delivered" }]
  ),
  rule("m-pack", "Packed stays packed", hourly, [
    { type: "set_fields", target: { self: true }, set: { packed: { const: "Yes" } } },
  ]),
  rule("m-ret", "Open returns", { type: "record_updated", when: eq("status", "Open") }, [
    { type: "alert", title: "A return is open", show: ["order"] },
  ]),
  rule("m-ret", "Code rule", hourly, [{ type: "run_code", code: "return {}" }]),
  {
    ...rule(null, "", hourly, []),
    changeType: "NEW_MODULE",
    automation: null,
    newModule: { name: "Courier Log", nav_label: "Courier Log", icon: "truck" },
  },
  rule("#Courier Log", "Log it", hourly, [{ type: "alert", title: "Logged" }]),
  rule("m-ret", "On a change", { type: "record_updated", when: { op: "changed", args: [{ field: "status" }] } }, [
    { type: "alert", title: "Changed" },
  ]),
  rule("m-ret", "RTO from returns", { type: "record_updated", when: eq("status", "Open") }, [
    {
      type: "set_fields",
      target: { module_id: "m-ship", match: { field: "order_number", to: { field: "order" } } },
      set: { rto: { const: "Yes" } },
    },
  ]),
  rule("m-cust", "Big buyers", hourly, [{ type: "alert", title: "Repeat", show: ["name"] }]),
  { ...rule("m-pack", "", hourly, []), changeType: "FEATURE_UPDATE", automation: null },
];

const { db, asked } = fakeDb();
const got = await dryRunRules(ctxOf(db), plans);
const of = (name) => got.find((d) => d.rule === name);

console.log("a rule that writes every row");
const rto = of("Mark RTO no");
check("is counted on the newest 2,000", rto?.matched === 2000 && rto.of === 2000 && rto.section === "Shipments");
check("and said to touch every row", rto?.everyRow === true);
check("and says the list is bigger", rto?.note?.includes("newest 2,000 of 2,353"));
check(
  "read a page at a time through the store's own page",
  asked.filter((q) => q.rpc === "abo_store_page" && q.p_module === "m-ship").length === 10
);
check(
  "each page at most 200",
  asked.filter((q) => q.rpc).every((q) => q.p_query.limit <= 200)
);

console.log("\na rule with a condition");
const delivered = of("Delivered alert");
check("counts the rows it matches", delivered?.matched === 500 && delivered.of === 2000 && !delivered.everyRow);
check("found by its #slug", delivered?.section === "Shipments");
check("a sample by order number", delivered?.sample.join() === "#1001,#1005,#1009");
const open = of("Open returns");
check("of the owner's own section", open?.matched === 7 && open.of === 30 && open.section === "Returns");
check("a rule on saves says it counts today's rows", open?.note?.includes("match today"));
check(
  "the owner's rows read from records, theirs alone",
  asked.some(
    (q) =>
      q.table === "records" &&
      q.filters.some(([k, c, v]) => k === "eq" && c === "module_id" && v === "m-ret") &&
      q.filters.some(([k, c, v]) => k === "is" && c === "store_row_id" && v === null)
  )
);
check(
  "each section read once",
  asked.filter((q) => q.table === "records" && q.filters.some(([, , v]) => v === "m-ret")).length === 1
);

console.log("\na rule that changes nothing");
const packed = of("Packed stays packed");
check("matches no row when every row already says it", packed?.matched === 0 && packed.of === 25 && !packed.everyRow);

console.log("\nwhat cannot be told in the head");
const code = of("Code rule");
check(
  "a rule of code: no count, and why",
  code?.matched === null && code.note === "A rule of code is tried on its first run."
);
const fresh = of("Log it");
check(
  "a section this design makes: no rows yet",
  fresh?.matched === null && fresh.section === "Courier Log" && /new in this design/.test(fresh.note)
);
const change = of("On a change");
check("a rule on a change: no count", change?.matched === null && /changes/.test(change.note));

console.log("\na rule that writes to another section");
const cross = of("RTO from returns");
check(
  "counts the rows it would write there",
  cross?.matched === 7 &&
    cross.of === 2000 &&
    cross.section === "Shipments" &&
    /through 7 of 30 Returns/.test(cross.note)
);

console.log("\nno one's details");
const customers = of("Big buyers");
check("a customer is never named", customers?.matched === 22 && customers.everyRow && customers.sample.length === 0);
const samples = got.flatMap((d) => d.sample).join(" ");
check("no name, phone or email in any sample", !/Asha|Person|98765|@/.test(samples));
check(
  "only rules are tried",
  got.length === 9 && got.every((d) => typeof d.plan === "number" && plans[d.plan].changeType === "AUTOMATION_ADD")
);

console.log("\nwhen it cannot look");
const broken = await dryRunRules(ctxOf(fakeDb({ fail: true }).db), plans);
check("a refused read says nothing", Array.isArray(broken) && broken.length === 0);
const stop = new AbortController();
const t0 = Date.now();
const waiting = dryRunRules(ctxOf(fakeDb({ hang: true }).db, { signal: stop.signal }), plans);
setTimeout(() => stop.abort(), 30);
const stopped = await waiting;
check("a stopped turn stops it", Date.now() - t0 < 1000 && Array.isArray(stopped));
check(
  "an already stopped turn reads nothing",
  (await dryRunRules(ctxOf(db, { signal: AbortSignal.abort() }), plans)).length === 0
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nevery rule is counted on its rows before it is built");
process.exit(fails.length ? 1 : 0);
