// A design used as the merchant will use it (lib/tryout.ts, 5 Oct): each
// part tried on the rows it will meet, with the app's own functions. A
// concrete break is a problem that goes back to Luke, what only might be
// is a note, and a part that works says nothing. Fields the design adds,
// which no row can hold yet, are never held against it. Pure: no
// database, no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-tryout.mjs

import { tryDesign, tryParts } from "../src/lib/tryout.ts";
import { redoFrom } from "../src/lib/review-gate.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const opts = { timeZone: "Asia/Kolkata", locale: "en-IN", now: new Date("2026-10-05T06:00:00Z") };
const section = (over = {}) => ({
  plan: 0,
  name: "Returns",
  columns: [],
  features: {},
  rows: [],
  storeFields: new Set(),
  fresh: new Set(),
  ...over,
});
const none = () => null;
const problems = (r) => r.found.filter((f) => f.severity === "problem").map((f) => f.text);
const notes = (r) => r.found.filter((f) => f.severity === "note").map((f) => f.text);

console.log("the row form has something to choose");
{
  const status = { field: "status", label: "Status", type: "badge" };
  const empty = tryParts(section({ columns: [status] }), none, opts);
  check("a status with no choices and no rows is a break", /Status has nothing to choose/.test(problems(empty)[0]));
  const given = tryParts(
    section({
      columns: [status],
      features: { filters: [{ field: "status", label: "Status", options: ["Open", "Done"] }] },
    }),
    none,
    opts
  );
  check("one with choices set works", given.found.length === 0 && given.tried === 1);
  const seeded = tryParts(section({ columns: [status], rows: [{ status: "Open" }] }), none, opts);
  check("one its rows give a value to works", seeded.found.length === 0);
  const store = tryParts(
    section({ columns: [{ ...status, field: "financial_status" }], storeFields: new Set(["financial_status"]) }),
    none,
    opts
  );
  check("the store's own status is never offered in a form, so not tried", store.tried === 0);
}

console.log("\na link has rows to pick, and says what picking fills");
{
  const order = { field: "order", label: "Order", type: "link", linkTo: "m-orders" };
  const cols = [
    order,
    { field: "customer_name", label: "Customer", type: "text" },
    { field: "reason", label: "Reason", type: "text" },
  ];
  const orders = {
    name: "Orders",
    store: true,
    columns: [{ field: "customer_name", label: "Customer", type: "text" }],
    rows: [{ id: "o1", customer_name: "Asha" }],
  };
  const r = tryParts(section({ columns: cols }), (l) => (l === "m-orders" ? orders : null), opts);
  check("a link to the store's orders works", r.found.length === 0 && r.tried === 1);
  check("and says what picking one fills", r.fills[0] === "Picking an Order fills Customer");
  const bare = tryParts(section({ columns: cols }), () => ({ ...orders, rows: [] }), opts);
  check(
    "a store list with no rows to pick is a break",
    /Order link offers nothing to pick: Orders has no rows/.test(problems(bare)[0])
  );
  const own = tryParts(section({ columns: cols }), () => ({ ...orders, rows: [], store: false }), opts);
  check(
    "an own section with none yet is a note",
    /until a row is added/.test(notes(own)[0]) && problems(own).length === 0
  );
}

console.log("\na worked-out column comes out as something");
{
  const days = {
    field: "days",
    label: "Days open",
    type: "number",
    compute: { op: "days_since", args: [{ field: "opened" }] },
  };
  const opened = { field: "opened", label: "Opened", type: "date" };
  const fine = tryParts(section({ columns: [opened, days], rows: [{ opened: "2026-10-01" }] }), none, opts);
  check("one that works out works", fine.found.length === 0 && fine.tried === 1);
  const level = {
    field: "level",
    label: "Level",
    type: "text",
    compute: {
      op: "if",
      args: [{ op: ">", args: [{ field: "qty" }, { const: 5 }] }, { const: "High" }, { field: "note" }],
    },
  };
  const broke = tryParts(
    section({
      columns: [{ field: "qty", label: "Qty", type: "number" }, { field: "note", label: "Note", type: "text" }, level],
      rows: [{ qty: 2 }],
    }),
    none,
    opts
  );
  check(
    "one blank on every row while what it reads is there is a break",
    /Level works out blank/.test(problems(broke)[0])
  );
  const nothing = tryParts(section({ columns: [opened, days], rows: [{ opened: "" }] }), none, opts);
  check(
    "one worked out from fields no row has is a note, saying the 0 it would show",
    /Days open is worked out from Opened, blank on all 1 Returns row: it shows 0 on every row/.test(notes(nothing)[0])
  );
  const fresh = tryParts(section({ columns: [opened, days], rows: [{}], fresh: new Set(["opened"]) }), none, opts);
  check("one reading a field the design adds is not held against it", fresh.tried === 0);
}

console.log("\na counter counts or adds up something");
{
  const rows = [
    { amount: "900", status: "Open" },
    { amount: "300", status: "Open" },
  ];
  const sum = (over) =>
    tryParts(section({ rows, features: { stats: [{ label: "Refunds", op: "sum", ...over }] } }), none, opts);
  check("a sum of numbers works", sum({ value: { field: "amount" } }).found.length === 0);
  check("a sum of words is a break", /adds up nothing/.test(problems(sum({ value: { field: "status" } }))[0]));
  check(
    "a condition no row meets is a note",
    /counts no row yet/.test(
      notes(sum({ value: { field: "amount" }, where: { op: "=", args: [{ field: "status" }, { const: "Done" }] } }))[0]
    )
  );
  check("grouped by a blank field is a break", /groups by city/.test(problems(sum({ op: "count", by: "city" }))[0]));
}

console.log("\na button shows, writes, and settles its row");
{
  const rows = [{ status: "Open" }];
  const when = { op: "!=", args: [{ field: "status" }, { const: "Done" }] };
  const act = (over) =>
    tryParts(
      section({ rows, features: { actions: [{ label: "Done", set: { status: { const: "Done" } }, when, ...over }] } }),
      none,
      opts
    );
  check("one that settles the row works", act({}).found.length === 0 && act({}).tried === 1);
  check(
    "one shown on no row is a note",
    /shows on none/.test(notes(act({ when: { op: "=", args: [{ field: "status" }, { const: "Lost" }] } }))[0])
  );
  check(
    "one that leaves itself showing is a note",
    /leaves the button on the same row/.test(notes(act({ set: { status: { const: "Open" } } }))[0])
  );
}

console.log("\na scan, an order, the dates it opens on, the view");
{
  const columns = [
    { field: "sku", label: "SKU", type: "text" },
    { field: "placed", label: "Placed", type: "date" },
    { field: "stage", label: "Stage", type: "badge" },
  ];
  const rows = [{ sku: "", placed: "2026-09-01", stage: "" }];
  const r = (features) => tryParts(section({ columns, rows, features }), none, opts);
  check(
    "a scan with no codes to match is a break",
    problems(r({ scanMode: { lookupField: "sku", action: { label: "Pick", set: {} } } })).some((t) =>
      /A scan matches nothing: SKU/.test(t)
    )
  );
  check(
    "opening on days that hold no row is a break: it would open empty",
    problems(r({ period: { field: "placed", presets: [7, 30], default: 7 } })).some((t) => /would open empty/.test(t))
  );
  check(
    "opening on days that do hold rows works",
    problems(r({ period: { field: "placed", presets: [7, 60], default: 60 } })).every(
      (t) => !/would open empty/.test(t)
    )
  );
  check(
    "a board by a blank field is a break",
    problems(r({ view: { type: "board", groupBy: "stage", cardTitle: "sku" } })).some((t) =>
      /board groups its columns by Stage/.test(t)
    )
  );
  check(
    "rows opening in order of a blank field is a note",
    notes(r({ defaultSort: { field: "sku", dir: "asc" } })).some((t) => /Rows open in order of SKU/.test(t))
  );
  const empty = tryParts(
    section({ columns, rows: [], features: { scanMode: { lookupField: "sku", action: { label: "Pick", set: {} } } } }),
    none,
    opts
  );
  check(
    "with no rows at all, nothing a row decides is tried",
    empty.found.every((f) => !/scan/.test(f.text))
  );
}

console.log("\nwhat goes back to Luke");
{
  const tryout = {
    tried: 3,
    fills: [],
    found: [
      { plan: 0, text: "A scan matches nothing.", severity: "problem" },
      { plan: 0, text: "A note.", severity: "note" },
    ],
  };
  const redo = redoFrom({ simplicity: null, data: [], dryRuns: [], ux: null, tryout }, []);
  check(
    "a break goes back, said as the merchant would meet it",
    /Used as they will use it:\n- A scan matches nothing\./.test(redo ?? "")
  );
  check("a note does not", !(redo ?? "").includes("A note."));
  check(
    "with the review switched off, nothing goes back",
    redoFrom({ simplicity: null, data: [], dryRuns: [], ux: null, tryout: null }, []) === null
  );
}

console.log("\na whole design, through the rows it will meet");
{
  // A stand-in for the caller's client: the store's orders, and returns of the owner's.
  const ORDERS = Array.from({ length: 12 }, (_, i) => ({
    id: `o-${i}`,
    data: { order_number: `#${1001 + i}`, customer_name: `Person ${i}`, total: 500 + i },
  }));
  const OWN = Array.from({ length: 8 }, (_, i) => ({ data: { order: `#${1001 + i}`, status: "Open" } }));
  const db = {
    rpc: (_name, args) =>
      Promise.resolve({
        data: {
          rows: args.p_module === "m-ord" ? ORDERS.slice(args.p_query.offset, args.p_query.offset + 200) : [],
          total: ORDERS.length,
          facets: {},
        },
        error: null,
      }),
    from() {
      const q = { filters: [] };
      const b = {
        select: (_c, o) => ((q.count = o?.count), b),
        eq: (c, v) => (q.filters.push([c, v]), b),
        is: () => b,
        order: () => b,
        range: (f, t) => ((q.range = [f, t]), b),
        then: (ok, no) => {
          const rows = q.filters.some(([c, v]) => c === "module_id" && v === "m-ret") ? OWN : [];
          return Promise.resolve({ data: rows, count: q.count ? rows.length : null, error: null }).then(ok, no);
        },
      };
      return b;
    },
  };
  const ctx = {
    db,
    projectId: "p-1",
    store: null,
    modules: [
      { id: "m-ord", name: "orders", nav_label: "Orders", source_table: "orders" },
      { id: "m-ret", name: "returns", nav_label: "Returns", source_table: null },
    ],
    schemas: new Map([
      ["m-ord", { columns: [] }],
      [
        "m-ret",
        {
          columns: [
            { field: "order", label: "Order", type: "text" },
            { field: "status", label: "Status", type: "badge" },
          ],
        },
      ],
    ]),
    ownerWords: "",
    understood: "",
    locale: "en-IN",
    currency: "INR",
    uxModel: null,
  };
  const plan = (p) => ({
    targetModuleId: null,
    newModule: null,
    newSchema: null,
    moduleUpdate: null,
    deleteConfirmName: null,
    features: null,
    automation: null,
    automationRemoveName: null,
    newRecords: null,
    explanation: "x",
    ...p,
  });
  const got = await tryDesign(ctx, [
    plan({
      changeType: "NEW_MODULE",
      newModule: { name: "claims", nav_label: "Claims", icon: "table" },
      newSchema: {
        columns: [
          { field: "order", label: "Order", type: "link", linkTo: "m-ord" },
          { field: "customer_name", label: "Customer", type: "text" },
          { field: "stage", label: "Stage", type: "badge" },
        ],
      },
    }),
    plan({
      changeType: "FEATURE_UPDATE",
      targetModuleId: "m-ret",
      features: { stats: [{ label: "Refunded", op: "sum", value: { field: "status" } }] },
    }),
    plan({ changeType: "AUTOMATION_ADD", targetModuleId: "m-ret", automation: { name: "x", definition: {} } }),
  ]);
  const said = got.found.map((f) => `${f.plan}:${f.severity}:${f.text}`);
  check("each section the design makes or changes is tried", got.tried >= 3);
  check(
    "the new section's status, with nothing to choose, is a break of its plan",
    said.some((t) => /^0:problem:.*Stage has nothing to choose/.test(t))
  );
  check(
    "its link to the store's orders has rows to pick, and fills the customer",
    got.fills.includes("Picking an Order fills Customer")
  );
  check(
    "the counter added to Returns, over words, is a break of its plan",
    said.some((t) => /^1:problem:.*'Refunded' counter adds up nothing/.test(t))
  );
  check("a rule is the dry-run's, not tried here", !said.some((t) => t.startsWith("2:")));
}

console.log(fails.length === 0 ? "\na design is tried as it will be used" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
