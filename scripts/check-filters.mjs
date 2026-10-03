// A dropdown that finds the rows it is pointing at.
//
// The failure this covers looked like a broken control and was not:
// the filter offered "active" and the rows said "ACTIVE", so every
// choice matched nothing. Nobody would find that by reading either
// side on its own — the options are written when a section is
// designed, the values arrive from Shopify weeks later.
//
// No database and no browser: this is about two strings and how they
// are compared.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-filters.mjs

import { filterOptions, matchesFilter } from "../src/lib/filters.ts";
import { parseReply } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const rows = (...values) => values.map((status) => ({ data: { status } }));

console.log("the case that shipped");
{
  // Twenty-one products from Shopify, a filter the assistant wrote.
  const products = rows(...Array(17).fill("ACTIVE"), "DRAFT", "ARCHIVED", null, "");
  const declared = ["active", "draft", "archived"];

  const matched = products.filter((r) => matchesFilter(r, "status", "active"));
  check("choosing active finds the active ones", matched.length === 17);
  check("and draft finds the draft one", products.filter((r) => matchesFilter(r, "status", "draft")).length === 1);

  const options = filterOptions(declared, products, "status");
  check("three choices, not six", options.length === 3);
  // The column beside the dropdown shows ACTIVE, so the dropdown says
  // ACTIVE. Two spellings of one thing is the bug, not the fix.
  check("shown the way the data spells them", options.join(",") === "ACTIVE,DRAFT,ARCHIVED");
}

console.log("\nand the ones it would have hit next");
{
  const typed = rows("Done", "done", " Done ", "Pending");
  check(
    "a merchant's own casing and spacing still match",
    typed.filter((r) => matchesFilter(r, "status", "done")).length === 3
  );
  check("without collapsing different values", filterOptions([], typed, "status").length === 2);
}
{
  // A value nobody predicted — Shopify adds one, or somebody types it.
  const unforeseen = rows("ACTIVE", "SUSPENDED");
  const options = filterOptions(["active"], unforeseen, "status");
  check("an unexpected value becomes a choice", options.includes("SUSPENDED"));
  check("and the declared one is not duplicated", options.length === 2);
}
{
  // A section built a moment ago, with nothing in it yet. Its whole
  // purpose is to say what rows will be filed under.
  const options = filterOptions(["Booked", "Ready", "Collected"], [], "stage");
  check("an empty section keeps its designed choices", options.length === 3);
  check("in the order they were designed", options[0] === "Booked");
}
{
  const blanks = [{ data: { status: null } }, { data: {} }, { data: { status: "  " } }];
  check("blanks are not offered as a category", filterOptions([], blanks, "status").length === 0);
  check(
    "and are never matched by a choice",
    blanks.every((r) => !matchesFilter(r, "status", "active"))
  );
}

{
  // Tags. The cell reads "Premium, Snow, Winter" because the array was
  // joined for display, and filtering it whole meant a shop could pick
  // "snowboard" out of the dropdown and be shown nothing at all.
  const tagged = [
    { data: { tags: "Accessory, Sport, Winter" } },
    { data: { tags: "Premium, Snow, Snowboard, Sport, Winter" } },
    { data: { tags: "cases" } },
    { data: { tags: null } },
  ];
  const options = filterOptions([], tagged, "tags");
  check("each tag is its own choice", options.includes("Winter") && options.includes("Premium"));
  check("not the whole list as one", !options.includes("Accessory, Sport, Winter"));
  check("and each appears once", options.filter((o) => o === "Winter").length === 1);

  const winter = tagged.filter((r) => matchesFilter(r, "tags", "Winter"));
  check("picking one finds every row carrying it", winter.length === 2);
  check("and not the rows without it", tagged.filter((r) => matchesFilter(r, "tags", "cases")).length === 1);

  // An option designed before any of this, spelling out the whole list.
  check("a choice that is itself a list still matches", matchesFilter(tagged[0], "tags", "Accessory, Sport, Winter"));

  // A field that holds the array itself, not the joined string.
  const raw = [{ data: { tags: ["Snow", "Winter"] } }];
  check("an array value works the same", matchesFilter(raw[0], "tags", "snow"));
  check("and lists its items", filterOptions([], raw, "tags").length === 2);
}

console.log("\na yes/no field is a tick: ticked, or not (an RTO column, 3 Oct)");
{
  const ticks = [true, "true", "yes", 1, false, "false", null, "", undefined].map((rto) => ({ data: { rto } }));
  check(
    "its choices are Yes and No, whatever was declared or stored",
    filterOptions(["Yes", "No", "true"], ticks, "rto", true).join() === "Yes,No"
  );
  check("Yes finds every tick, however stored", ticks.filter((r) => matchesFilter(r, "rto", "Yes", true)).length === 4);
  check(
    "No finds every row not ticked, blank and false alike",
    ticks.filter((r) => matchesFilter(r, "rto", "No", true)).length === 5
  );

  const SHIP = "55555555-5555-4555-8555-555555555555";
  const modules = [
    { id: SHIP, project_id: "p", name: "shipments", nav_label: "Shipments", icon: "table", source_table: null },
  ];
  const order = { field: "order_number", label: "Order", type: "text" };
  const rto = { field: "rto", label: "RTO", type: "boolean" };
  const reply = (plans) =>
    parseReply(JSON.stringify({ type: "plans", message: "RTO.", plans }), modules, { columns: [order] }, null);
  const filterOf = (r) => r.ok && r.reply.plans.at(-1).features.filters.find((f) => f.field === "rto");
  const asked = reply([
    {
      changeType: "FIELD_ADD",
      targetModuleId: SHIP,
      newSchema: { columns: [order, rto] },
      explanation: "A tick for RTO.",
    },
    {
      changeType: "FEATURE_UPDATE",
      targetModuleId: SHIP,
      features: { filters: [{ field: "rto", label: "RTO", options: ["true", "false"] }] },
      explanation: "Filter by it.",
    },
  ]);
  check(
    "a field and its filter in one design: the filter reads Yes / No",
    filterOf(asked)?.options?.join() === "Yes,No"
  );
  if (!asked.ok) console.log("     →", asked.errors);
  const bare = parseReply(
    JSON.stringify({
      type: "plans",
      message: "RTO.",
      plans: [
        {
          changeType: "FEATURE_UPDATE",
          targetModuleId: SHIP,
          features: { filters: [{ field: "rto", label: "RTO" }] },
          explanation: "Filter by it.",
        },
      ],
    }),
    modules,
    { columns: [order, rto] },
    null
  );
  check("sent with no choices, it is kept, not refused or dropped", filterOf(bare)?.options?.join() === "Yes,No");
  if (!bare.ok) console.log("     →", bare.errors);
}

console.log(fails.length === 0 ? "\nthe dropdown points at the rows" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
