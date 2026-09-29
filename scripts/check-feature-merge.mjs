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
import { changeShown } from "../src/lib/change-preview.ts";
import { describeForOwner, describePlan } from "../src/lib/describe.ts";

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
// A part the section has had for a long time, which today's rules would
// refuse, stays as it is and does not block a change to another part.
const legacy = { ...features, actions: [{ label: "Tick", set: { gone: { const: true } } }] };
check("a part the change leaves out is not judged again", validatePlan(plan(change), modules, schema, legacy).ok);

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

// Its preview draws what it changes, not the section again: the whole
// section beside the chat showed what was behind it already.
console.log("\na preview draws only what the change does");
const here = {
  columns: [
    { field: "order_number", label: "Order", type: "text" },
    { field: "sku", label: "SKU", type: "text" },
  ],
  features: { stats: [{ label: "Lines", op: "count" }], search: { enabled: true } },
};
const seen = (plan) => changeShown({ targetModuleId: MOD, explanation: "", ...plan }, here);
const fieldAdd = seen({
  changeType: "FIELD_ADD",
  newSchema: { columns: [...here.columns, { field: "packed_by", label: "Packed by", type: "text" }] },
});
check(
  "a field added: the new one beside the first, and nothing else",
  fieldAdd?.columns.map((c) => c.field).join() === "order_number,packed_by" && !fieldAdd.features
);
const counter = seen({ changeType: "FEATURE_UPDATE", features: { stats: [{ label: "Packed", op: "count" }] } });
check(
  "a part changed: that part, over the section's columns",
  JSON.stringify(Object.keys(counter?.features ?? {})) === '["stats"]' && counter.columns.length === 2
);
const written = seen({
  changeType: "FEATURE_UPDATE",
  features: { view: { type: "custom", title: "Station", html: "<p>" }, stats: [{ label: "Packed", op: "count" }] },
});
check("a written screen: the screen alone", JSON.stringify(Object.keys(written?.features ?? {})) === '["view"]');
check("a part only removed draws nothing", seen({ changeType: "FEATURE_UPDATE", features: { search: null } }) === null);
check(
  "and its card names only the new field, not the section's own",
  describeForOwner(
    {
      changeType: "FIELD_ADD",
      targetModuleId: MOD,
      explanation: "",
      newSchema: { columns: [...here.columns, { field: "packed_by", label: "Packed by", type: "text" }] },
    },
    modules,
    here.columns
  ).lines[0] === "New: Packed by"
);
const screenPlan = {
  changeType: "FEATURE_UPDATE",
  targetModuleId: MOD,
  explanation: "",
  features: { view: { type: "custom", title: "Station", html: "<p>Scan the box label</p>" } },
};
check(
  "a written screen is named on the card, not read out: the preview shows it",
  describeForOwner(screenPlan, modules).lines.includes("A screen written for it, “Station”")
);
check(
  "while the critic's words are as its recordings hold them",
  describePlan(screenPlan, modules).lines.some((l) => l.includes("Scan the box label"))
);
check("a rename draws nothing", seen({ changeType: "MODULE_UPDATE", moduleUpdate: { nav_label: "Pack" } }) === null);
const fresh = changeShown(
  {
    changeType: "NEW_MODULE",
    targetModuleId: null,
    explanation: "",
    newSchema: { columns: here.columns },
    features: { view: { type: "custom", title: "Station", html: "<p>" } },
  },
  null
);
check("a new section, with its parts: its written screen too", fresh?.features?.view?.type === "custom");

console.log(
  fails.length === 0 ? "\na change is laid over the section, and keeps what it leaves out" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
