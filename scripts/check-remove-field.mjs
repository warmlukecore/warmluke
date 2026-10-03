// A column comes off a section: hidden, or a field of theirs removed
// once nothing reads it.
//
// Since the first day a change could only add: "removing a column is not
// something this platform can do". Every round on an RTO section stacked
// a field on the last, four in all (Tanish, 3 Oct). A field's values stay
// on its rows whatever the section shows; what breaks when one goes is
// whatever still reads it, so that is what is checked, over the whole
// design. The store's own columns are only ever hidden.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-remove-field.mjs

import { parseReply } from "../src/lib/ai.ts";
import { storeSectionColumns } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const SHIP = "66666666-6666-4666-8666-666666666666";
const ORD = "77777777-7777-4777-8777-777777777777";
const modules = [
  { id: SHIP, project_id: "p", name: "shipments", nav_label: "Shipments", icon: "table", source_table: null },
  { id: ORD, project_id: "p", name: "orders", nav_label: "Orders", icon: "table", source_table: "orders" },
];
const order = { field: "order_number", label: "Order", type: "text" };
const rto = { field: "rto", label: "RTO", type: "boolean" };
const status = { field: "rto_status", label: "RTO status", type: "badge" };
const schema = { columns: [order, rto, status] };
const ui = (columns) => ({
  changeType: "UI_CHANGE",
  targetModuleId: SHIP,
  newSchema: { columns },
  explanation: "Simpler.",
});
const design = (plans, { features = null, rules = [] } = {}) =>
  parseReply(
    JSON.stringify({ type: "plans", message: "Simpler.", plans }),
    modules,
    schema,
    features,
    undefined,
    (mid) => rules.filter((r) => r.module_id === mid)
  );
const errorsOf = (r) => (r.ok ? "" : r.errors.join(" "));
const filterOnStatus = { filters: [{ field: "rto_status", label: "RTO", options: ["Yes", "No"] }] };
const fillRule = {
  module_id: SHIP,
  name: "Fill RTO status on new shipments",
  definition: {
    trigger: { type: "schedule", every: "hourly" },
    actions: [{ type: "set_fields", set: { rto_status: { const: "No" } } }],
  },
};

console.log("a field of theirs, taken off");
check("when nothing reads it, it goes", design([ui([order, rto])]).ok);
const filtered = design([ui([order, rto])], { features: filterOnStatus });
check("when a filter reads it, it stays, and the filter is named", errorsOf(filtered).includes('the filter "RTO"'));
check(
  "unless the same design changes the filter",
  design(
    [
      ui([order, rto]),
      { changeType: "FEATURE_UPDATE", targetModuleId: SHIP, features: { filters: null }, explanation: "No filter." },
    ],
    {
      features: filterOnStatus,
    }
  ).ok
);
const ruled = design([ui([order, rto])], { rules: [fillRule] });
check(
  "when a rule reads it, the rule is named",
  errorsOf(ruled).includes('the rule "Fill RTO status on new shipments"')
);
check(
  "unless the same design removes the rule",
  design(
    [
      ui([order, rto]),
      {
        changeType: "AUTOMATION_REMOVE",
        targetModuleId: SHIP,
        automationRemoveName: "Fill RTO status on new shipments",
        explanation: "Not needed.",
      },
    ],
    { rules: [fillRule] }
  ).ok
);
const screen = {
  tabs: [
    {
      type: "custom",
      title: "Simple table",
      html: "<div id=b></div><script>wl.rows().then(r=>b.textContent=r.map(x=>x.data.rto_status).join())</script>",
    },
  ],
};
check(
  "a written screen that reads it keeps it",
  errorsOf(design([ui([order, rto])], { features: screen })).includes('the tab "Simple table"')
);
const worked = design([
  ui([
    order,
    rto,
    {
      field: "flag",
      label: "Flag",
      type: "badge",
      compute: {
        op: "if",
        args: [{ op: "=", args: [{ field: "rto_status" }, { const: "Yes" }] }, { const: "RTO" }, { const: "" }],
      },
    },
  ]),
]);
check("and so does a column worked out from it", errorsOf(worked).includes('the column "Flag"'));
check(
  "a label that happens to say it is not a reader",
  design([ui([order, rto])], { features: { stats: [{ op: "count", label: "rto_status" }] } }).ok
);

console.log("\nthe store's own columns");
const theirs = storeSectionColumns("orders", []);
const storeDesign = (columns) =>
  parseReply(
    JSON.stringify({
      type: "plans",
      message: "Fewer.",
      plans: [{ changeType: "UI_CHANGE", targetModuleId: ORD, newSchema: { columns }, explanation: "Fewer." }],
    }),
    modules,
    { columns: theirs },
    null
  );
const without = storeDesign(theirs.filter((c) => c.field !== "ship_city"));
check("are not removed: hide them", errorsOf(without).includes('"hidden": true'));
const hiding = storeDesign(theirs.map((c) => (c.field === "ship_city" ? { ...c, hidden: true } : c)));
check("hidden, the design is taken", hiding.ok);
if (!hiding.ok) console.log("     →", hiding.errors);
const kept = storeSectionColumns("orders", [{ field: "ship_city", label: "City", type: "text", hidden: true }]);
check(
  "and stays hidden however the store's list is laid out",
  kept.find((c) => c.field === "ship_city")?.hidden === true
);
check("while the rest are shown", kept.filter((c) => c.hidden).length === 1);

console.log("\na section deleted while a rule of another reads it");
{
  const FLAGS = "88888888-1111-4888-8888-888888888888";
  const mods = [
    { id: SHIP, project_id: "p", name: "shipments", nav_label: "Shipments", icon: "table", source_table: null },
    {
      id: FLAGS,
      project_id: "p",
      name: "flagged-orders",
      nav_label: "Flagged Orders",
      icon: "table",
      source_table: null,
    },
  ];
  const flagRule = {
    module_id: FLAGS,
    name: "Flag repeat orders",
    definition: {
      trigger: { type: "store_row_added" },
      actions: [{ type: "run_code", reads: [SHIP], code: "sections['#shipments']" }],
    },
  };
  const del = (extra = []) =>
    parseReply(
      JSON.stringify({
        type: "plans",
        message: "Gone.",
        plans: [
          ...extra,
          {
            changeType: "MODULE_DELETE",
            targetModuleId: SHIP,
            deleteConfirmName: "shipments",
            explanation: "Not needed any more.",
          },
        ],
      }),
      mods,
      null,
      null,
      undefined,
      (mid) => [flagRule].filter((r) => r.module_id === mid)
    );
  check("is refused, naming the rule that reads it", errorsOf(del()).includes('"Flag repeat orders" reads #shipments'));
  check(
    "unless the same design removes that rule",
    del([
      {
        changeType: "AUTOMATION_REMOVE",
        targetModuleId: FLAGS,
        automationRemoveName: "Flag repeat orders",
        explanation: "It read the shipments.",
      },
    ]).ok
  );
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\na column comes off, and nothing that reads it breaks");
process.exit(fails.length ? 1 : 0);
