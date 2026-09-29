// A change to a section is laid over what it has, not put in its place.
//
// A features change used to replace them all, so Luke sent every part
// back to change one, and a part he left out was gone: a counter added
// to a written screen meant sending the whole screen again. And a field
// added with the section's columns in another order was refused, a
// whole attempt spent on "order_number" not being first. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-feature-merge.mjs

import { validatePlan } from "../src/lib/ai.ts";
import { mergeFeatures } from "../src/lib/types.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const MOD = "c0ffee00-0000-4000-8000-000000000001";
const modules = [
  {
    id: MOD,
    project_id: "p",
    parent_id: null,
    name: "packing",
    nav_label: "Packing",
    icon: "table",
    route: "/packing",
    sort_order: 1,
    source_table: null,
    created_at: "2026-01-01",
  },
];
const schema = {
  columns: [
    { field: "order_number", label: "Order", type: "text" },
    { field: "sku", label: "SKU", type: "text" },
    { field: "scanned", label: "Scanned", type: "number" },
  ],
};
const screen = {
  type: "custom",
  title: "Packing station",
  html: "<div class=wl-page><input class=wl-scan></div><script>wl.onRows(() => {});</script>",
};
const features = {
  view: screen,
  filters: [{ field: "sku", label: "SKU", options: ["A", "B"] }],
  stats: [{ op: "count", label: "Lines" }],
};

console.log("a change to a section's features");
const change = {
  stats: [
    { op: "count", label: "Lines" },
    { op: "sum", label: "Scanned", value: { field: "scanned" } },
  ],
};
const merged = mergeFeatures(features, change);
check("the part it names is replaced", merged.stats.length === 2);
check(
  "the parts it leaves out stay: the screen, word for word, and the filters",
  merged.view === screen && merged.filters === features.filters
);
check("null takes a part away", !("filters" in mergeFeatures(features, { filters: null })));
check("and nothing at all changes nothing", JSON.stringify(mergeFeatures(features, {})) === JSON.stringify(features));
const plan = (f) => ({
  changeType: "FEATURE_UPDATE",
  targetModuleId: MOD,
  features: f,
  explanation: "Adds a count of scans.",
});
check("a change naming only stats is taken", validatePlan(plan(change), modules, schema, features).ok);
const bad = validatePlan(
  plan({ stats: [{ op: "sum", label: "Nope", value: { field: "weight" } }] }),
  modules,
  schema,
  features
);
check(
  "and is still checked: a stat over a field there is not is refused",
  !bad.ok && /weight/.test(bad.errors.join(" "))
);

console.log("\na field added with the columns in another order");
const add = (columns) =>
  validatePlan(
    { changeType: "FIELD_ADD", targetModuleId: MOD, newSchema: { columns }, explanation: "Adds who packed it." },
    modules,
    schema,
    features
  );
const moved = add([
  { field: "packed_by", label: "Packed by", type: "text" },
  { field: "sku", label: "Item code", type: "text" },
]);
check("is taken, not refused", moved.ok);
const cols = moved.plan?.newSchema?.columns ?? [];
check(
  "every column the section had is kept, in its place",
  cols
    .slice(0, 3)
    .map((c) => c.field)
    .join() === "order_number,sku,scanned"
);
check("one sent again with a new label is taken as sent", cols[1]?.label === "Item code");
check("and the new one comes after them", cols[3]?.field === "packed_by" && cols.length === 4);
check("a field add with nothing new is still refused", !add(schema.columns).ok);

console.log(
  fails.length === 0 ? "\na change is laid over the section, and keeps what it leaves out" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
