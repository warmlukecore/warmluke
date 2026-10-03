// A section's views as tabs (features.tabs): a screen beside the table,
// never in place of the store's list.
//
// A section had one view, so asked for a screen over Orders, Luke wrote
// one and the table went. Now more views sit in tabs after the section's
// own; on a section over the store a written screen is only ever a tab;
// the card says what a change adds, and which tab it would take away.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-tabs.mjs

import { validateFeatures } from "../src/lib/ai.ts";
import { describeFeaturesFull, describeForOwner } from "../src/lib/describe.ts";
import { changeShown } from "../src/lib/change-preview.ts";
import { sectionTabs, tabName } from "../src/lib/tabs.ts";
import { mergeFeatures } from "../src/lib/types.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const columns = [
  { field: "order_number", label: "Order", type: "text" },
  { field: "placed_at", label: "Placed", type: "date" },
  { field: "status", label: "Status", type: "badge" },
  { field: "packed", label: "Packed", type: "boolean" },
];
const store = new Set(["order_number", "placed_at", "status"]);
const errorsOf = (features, storeFields) => {
  const errors = [];
  validateFeatures(structuredClone(features), columns, errors, undefined, storeFields);
  return errors;
};
const screen = (title) => ({ type: "custom", title, html: "<div id=app></div><script>wl.onRows(() => {})</script>" });
const board = { type: "board", label: "By status", groupBy: "status", cardTitle: "order_number" };

console.log("what a tab is called, and the row of them");
check("a written screen by its title", tabName(screen("Packing station")) === "Packing station");
check(
  "another view by its label, or its kind",
  tabName(board) === "By status" && tabName({ type: "list", titleField: "order_number" }) === "List"
);
check(
  "the section's own view first, a table when it has none",
  JSON.stringify(sectionTabs({ tabs: [board] }).map(tabName)) === '["Table","By status"]'
);

console.log("\nthe validator");
check("a screen beside the store's list is taken", errorsOf({ tabs: [screen("Packing station")] }, store).length === 0);
check(
  "a screen in place of the store's list is refused, and told where it goes",
  errorsOf({ view: screen("Packing station") }, store)
    .join(" ")
    .includes('send it in "tabs"')
);
check("a section of their own may be a screen", errorsOf({ view: screen("Packing station") }).length === 0);
check(
  "each tab is checked as a view",
  errorsOf({ tabs: [{ type: "board", cardTitle: "order_number" }] })
    .join(" ")
    .includes("groupBy") &&
    errorsOf({ tabs: [{ type: "custom", html: "<div></div>" }] })
      .join(" ")
      .includes('"title"')
);
check(
  "two tabs with one name are refused",
  errorsOf({ tabs: [screen("Packing"), screen("packing")] })
    .join(" ")
    .includes("Two tabs are called")
);
check(
  "at most four",
  errorsOf({ tabs: [1, 2, 3, 4, 5].map((n) => screen(`Screen ${n}`)) })
    .join(" ")
    .includes("At most 4")
);
check(
  "a list, not one view",
  errorsOf({ tabs: screen("Packing") })
    .join(" ")
    .includes("list of views")
);

console.log("\nlaid over what the section has");
const had = { view: { type: "table" }, tabs: [screen("Packing station")] };
check("tabs sent replace the row of them", mergeFeatures(had, { tabs: [board] }).tabs.length === 1);
check("left out, they stay", mergeFeatures(had, { stats: [] }).tabs?.[0]?.title === "Packing station");
check("null takes them away", mergeFeatures(had, { tabs: null }).tabs === undefined);

console.log("\nthe card");
const modules = [{ id: "m1", name: "orders", nav_label: "Orders", source_table: "orders" }];
const plan = (features) => ({ changeType: "FEATURE_UPDATE", targetModuleId: "m1", features });
check(
  "says what each tab is",
  JSON.stringify(describeFeaturesFull({ tabs: [board, screen("Packing station")] }, modules)) ===
    JSON.stringify(["A tab “By status”, shown as a board grouped by status", "A tab written for it, “Packing station”"])
);
check(
  "a written tab is named, not read out: its screen is in the preview",
  describeForOwner(plan({ tabs: [screen("Packing station")] }), modules, columns, null, null).lines[0] ===
    "A tab written for it, “Packing station”"
);
check(
  "a tab added takes nothing away, and says nothing",
  (describeForOwner(plan({ tabs: [screen("Packing station")] }), modules, columns, null, null).warnings ?? [])
    .length === 0
);
const warned = describeForOwner(plan({ tabs: [board] }), modules, columns, null, had).warnings ?? [];
check(
  "a tab left out of the row is said to go",
  warned.length === 1 && warned[0].startsWith("Orders will lose its tab “Packing station”")
);
check(
  "not when the section is not in view: what it has is not known",
  (describeForOwner(plan({ tabs: [board] }), modules, columns, null, undefined).warnings ?? []).length === 0
);

console.log("\nthe preview");
const shown = changeShown(plan({ tabs: [screen("Packing station")] }), {
  columns,
  features: { view: { type: "table" } },
});
check("a screen added as a tab is previewed whole", shown?.features?.view?.title === "Packing station");
const both = changeShown(plan({ tabs: [screen("Packing station"), screen("Dispatch")] }), {
  columns,
  features: { tabs: [screen("Packing station")] },
});
check("the one this change brings, when it has one already", both?.features?.view?.title === "Dispatch");
check(
  "a board added as a tab is drawn as the change",
  changeShown(plan({ tabs: [board] }), { columns })?.features?.tabs?.length === 1
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\na section's views are tabs, and the store's list stays");
process.exit(fails.length ? 1 : 0);
