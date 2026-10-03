// A design read against the store's own rows (data-check.ts): a value
// spelled other than the rows spell it, a value no row has, a field
// blank on every row, and a rule matching rows by values two sections
// never share.
//
// Pure: no database (a stand-in that serves fixture rows for a section
// over the store, through abo_store_page with its facets, and for a
// section of the owner's, from records) and no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-data-check.mjs

import { checkAgainstData } from "../src/lib/data-check.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const SHIPMENTS = Array.from({ length: 60 }, (_, i) => ({
  id: `f-${i}`,
  data: {
    order_number: `#${1001 + i}`,
    carrier: i % 2 ? "Delhivery" : "Blue Dart",
    tracking_number: "",
    shipment_status: i % 4 === 0 ? "Delivered" : "In Transit",
  },
}));
const RETURNS = Array.from({ length: 30 }, (_, i) => ({
  data: { order: `${1001 + i}`, status: i < 7 ? "Open" : "Closed" },
}));

/** A stand-in for the caller's client. The store's page also gives a value past the rows read, as the whole list would. */
function fakeDb({ fail = false } = {}) {
  const asked = [];
  return {
    asked,
    db: {
      rpc(name, args) {
        asked.push({ rpc: name, ...args });
        if (fail) return Promise.resolve({ data: null, error: { message: "permission denied" } });
        const { offset = 0, limit = 50, facets = [] } = args.p_query;
        const values = Object.fromEntries(
          facets.map((f) => [
            f,
            [...new Set(SHIPMENTS.map((r) => r.data[f]).filter(Boolean)), ...(f === "shipment_status" ? ["Lost"] : [])],
          ])
        );
        return Promise.resolve({
          data: { rows: SHIPMENTS.slice(offset, offset + limit), total: SHIPMENTS.length, facets: values },
          error: null,
        });
      },
      from(table) {
        const q = { table, filters: [] };
        asked.push(q);
        const b = {
          select: (cols, opts) => ((q.count = opts?.count), b),
          eq: (c, v) => (q.filters.push([c, v]), b),
          is: () => b,
          order: () => b,
          range: (from, to) => ((q.range = [from, to]), b),
          then: (ok, no) =>
            Promise.resolve(
              fail
                ? { data: null, error: { message: "permission denied" } }
                : { data: RETURNS.slice(q.range[0], q.range[1] + 1), count: RETURNS.length, error: null }
            ).then(ok, no),
        };
        return b;
      },
    },
  };
}

const RETURN_COLUMNS = [
  { field: "order", label: "Order", type: "text" },
  { field: "status", label: "Status", type: "badge" },
];
const ctxOf = (db) => ({
  db,
  projectId: "p-1",
  store: null,
  modules: [
    { id: "m-ship", name: "shipments", nav_label: "Shipments", source_table: "fulfillments" },
    { id: "m-ret", name: "returns", nav_label: "Returns", source_table: null },
  ],
  schemas: new Map([
    ["m-ship", { columns: [] }],
    ["m-ret", { columns: RETURN_COLUMNS }],
  ]),
  ownerWords: "",
  understood: "",
  locale: "en-IN",
  currency: "INR",
  uxModel: null,
});
const plan = (changeType, target, more = {}) => ({
  changeType,
  targetModuleId: target,
  newModule: null,
  newSchema: { columns: [] },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
  ...more,
});
const rule = (target, when, actions = [{ type: "alert", title: "Look" }]) =>
  plan("AUTOMATION_ADD", target, {
    automation: { name: "A rule", definition: { trigger: { type: "schedule", every: "daily", when }, actions } },
  });
const eq = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });

const plans = [
  /* 0 */ rule("m-ship", eq("shipment_status", "in transit")),
  /* 1 */ rule("m-ship", eq("shipment_status", "Returned")),
  /* 2 */ rule("m-ship", eq("shipment_status", "Lost")),
  /* 3 */ plan("FEATURE_UPDATE", "#Shipments", {
    features: {
      filters: [
        { field: "shipment_status", label: "Status", options: ["delivered", "In-Transits", "Cancelled"] },
        { field: "tracking_number", label: "Tracking", options: [] },
      ],
    },
  }),
  /* 4 */ plan("FIELD_ADD", "m-ret", {
    newSchema: { columns: [...RETURN_COLUMNS, { field: "reason", label: "Reason", type: "text" }] },
  }),
  /* 5 */ plan("FEATURE_UPDATE", "m-ret", {
    features: {
      filters: [{ field: "reason", label: "Reason", options: ["Damaged"] }],
      stats: [{ label: "Open", op: "count", where: eq("status", "Open") }],
    },
  }),
  /* 6 */ rule("m-ret", eq("status", "Open"), [
    {
      type: "set_fields",
      target: { module_id: "m-ship", match: { field: "order_number", to: { field: "order" } } },
      set: { rto: { const: "Yes" } },
    },
  ]),
  /* 7 */ rule("m-ship", { op: ">", args: [{ field: "order_number" }, { const: 1000 }] }),
];

const { db, asked } = fakeDb();
const found = await checkAgainstData(ctxOf(db), plans);
const of = (i) => found.filter((f) => f.plan === i);
const says = (i, severity, text) => of(i).some((f) => f.severity === severity && f.text === text);

console.log("values the rows do not have");
check(
  "a case slip is a problem, with the rows' own spelling",
  says(0, "problem", "'in transit' is never a status here; the rows say 'In Transit'.")
);
check("a value no row has yet is a note", says(1, "note", "No Shipments row has Status 'Returned' yet."));
check("a value the whole list has, past the rows read, is fine", of(2).length === 0);
check(
  "the store was asked for the values over the whole list",
  asked.some((q) => q.rpc === "abo_store_page" && q.p_query.facets.includes("shipment_status"))
);

console.log("\na filter's choices");
check("a choice differing only in case is fine: filters ignore it", !of(3).some((f) => f.text.includes("'delivered'")));
check(
  "a choice spelled another way is a problem",
  says(3, "problem", "'In-Transits' is never a status here; the rows say 'In Transit'.")
);
check("a choice no row has is a note", says(3, "note", "No Shipments row has Status 'Cancelled' yet."));

console.log("\nfields with nothing in them");
check("a field blank on every row is a note", says(3, "note", "Tracking is blank on all 60 Shipments rows."));
check(
  "a field this design adds is not checked",
  of(5).every((f) => !f.text.includes("Reason"))
);
check("a stat's value the rows have is fine", of(5).length === 0);
check("a number is not looked for among the words", of(7).length === 0);

console.log("\na rule matching rows in another section");
check(
  "values the two never share are a problem",
  says(
    6,
    "problem",
    "Order in Shipments never equals Order on any Returns row (the rows say '#1001' and '1001'), so the rule would find nothing to change."
  )
);
check("each section read once", asked.filter((q) => q.table === "records").length === 1);

console.log("\nwhen it cannot look");
check(
  "an error from the database says nothing",
  (await checkAgainstData(ctxOf(fakeDb({ fail: true }).db), plans)).length === 0
);
check(
  "a design leaning on nothing reads nothing",
  (await checkAgainstData(ctxOf(fakeDb().db), [plans[4]])).length === 0
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\na design is read against the rows it leans on");
process.exit(fails.length ? 1 : 0);
