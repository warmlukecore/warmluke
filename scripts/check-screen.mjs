// Luke working on the screen that is open (lib/screen.ts, #3, 5 Oct): what
// he, or a link from the merchant's own AI, asks of a section is held to
// the section's own filters, columns and dates; what it does not have is
// left out and said; a row to put in is filled as its form holds it and
// never where nothing is typed; the receipt is the code's words; the link
// reads back as it was; and with a section open, asking to see its rows
// or giving a row to put in is talk, while asking for a part of the app
// stays a design. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-screen.mjs

import { roadFor } from "../src/lib/intent.ts";
import { describeScreenAsk, readScreenAsk, screenFromHref, screenHref } from "../src/lib/screen.ts";
import { shownOnScreen } from "../src/lib/engine.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const schema = {
  columns: [
    { field: "order", label: "Order", type: "link", linkTo: "m-orders" },
    { field: "customer_name", label: "Customer", type: "text" },
    { field: "reason", label: "Reason", type: "dropdown" },
    { field: "status", label: "Status", type: "badge" },
    { field: "amount", label: "Amount", type: "currency" },
    { field: "refunded", label: "Refunded", type: "boolean" },
    { field: "received", label: "Received on", type: "date" },
    {
      field: "days_open",
      label: "Days open",
      type: "number",
      compute: { op: "days_since", args: [{ field: "received" }] },
    },
  ],
  features: {
    filters: [
      { field: "reason", label: "Reason", options: ["Size", "Damaged"] },
      { field: "status", label: "Status", options: ["Requested", "Received"] },
      { field: "refunded", label: "Refunded", options: [] },
      { field: "customer_name", label: "Customer", options: [], hidden: true },
    ],
    period: { field: "received", presets: [7, 30] },
  },
};
const returns = { id: "m-returns", name: "Returns", schema, canAdd: true };
const read = (raw, section = returns) => readScreenAsk(raw, section);

console.log("a view, held to the section's own bar");
{
  const { ask, left } = read({
    filters: { status: "requested", Reason: "size", refunded: "yes", courier: "Delhivery", customer_name: "Asha" },
    search: "  Asha ",
    sort: { field: "Received on", dir: "desc" },
    period: { named: "last_week" },
  });
  check("its filters, spelled as they offer them", ask.filters.status === "Requested" && ask.filters.reason === "Size");
  check("a yes/no filter as Yes or No", ask.filters.refunded === "Yes");
  check(
    "a filter it does not have is left out, and said",
    !("courier" in ask.filters) && left.includes("Returns has no courier filter")
  );
  check("one taken off the bar with Customize is not set", !("customer_name" in ask.filters));
  check("the search, trimmed", ask.search === "Asha");
  check("a column named by its label sorts by its field", ask.sort.field === "received" && ask.sort.dir === "desc");
  check("a named span of dates", ask.period.named === "last_week");
  check("the section is the caller's, never the model's", ask.moduleId === "m-returns");
  check(
    "said in the code's words",
    describeScreenAsk(ask, returns) ===
      'Returns: Status: Requested · Reason: Size · Refunded: Yes · searched "Asha" · last week · Received on, newest first'
  );
}
{
  const { ask, left } = read({ filters: { status: "Lost" }, period: { days: 12 }, sort: { field: "courier" } });
  check(
    "a choice its filter does not offer is left out, and said",
    ask === null && left.includes('Status offers no "Lost"')
  );
  check(
    "dates it cannot be set to, said",
    left.some((l) => l.startsWith("its dates cannot be set to"))
  );
  check("a column it does not have to sort by, said", left.includes("Returns has no courier column to sort by"));
  check(
    "a sort said as the column reads: names A to Z, money highest first",
    describeScreenAsk(read({ sort: { field: "customer_name" } }).ask, returns) === "Returns: Customer, A to Z" &&
      describeScreenAsk(read({ sort: { field: "amount", dir: "desc" } }).ask, returns) ===
        "Returns: Amount, highest first"
  );
  check("every date", read({ period: "all" }).ask.period === null);
  check("one of its presets", read({ period: { days: 30 } }).ask.period.days === 30);
  check(
    "its own two dates",
    read({ period: { from: "2026-10-01", to: "2026-10-05" } }).ask.period.from === "2026-10-01"
  );
  check("nothing asked is nothing done", read({}).ask === null && read("filter it").ask === null);
  check("no section open is nothing done", readScreenAsk({ search: "x" }, { ...returns, schema: null }).ask === null);
}

console.log("\na row to put in, as its form holds it");
{
  const { ask, left } = read({
    add: {
      Order: "#1042",
      customer_name: "Asha",
      reason: "size",
      status: "Pending",
      amount: "₹1,200",
      refunded: "no",
      received: "2026-10-04T10:00:00Z",
      days_open: 3,
      courier: "Delhivery",
      notes: "",
    },
  });
  check("a link is the words of its row, for the form to find", ask.add.order === "#1042");
  check("text as given", ask.add.customer_name === "Asha");
  check("a dropdown's choice, spelled as set up", ask.add.reason === "Size");
  check(
    "a choice it is not set up with is left out, and said",
    !("status" in ask.add) && left.includes('Status cannot hold "Pending"')
  );
  check("money as a number", ask.add.amount === 1200);
  check("a yes/no as true or false", ask.add.refunded === false);
  check("a date as its day", ask.add.received === "2026-10-04");
  check("never a worked-out field", !("days_open" in ask.add) && left.includes("Days open is worked out, not typed"));
  check("a field it does not have, said", left.includes("Returns has no courier field"));
  check("nothing given is not said", !left.some((l) => l.includes("notes")));
  check(
    "said as which fields are filled",
    describeScreenAsk(ask, returns).startsWith("a new row in Returns, Order, Customer")
  );
  check("Rs and commas read as money", read({ add: { amount: "Rs. 2,450" } }).ask.add.amount === 2450);
  const store = read({ add: { customer_name: "Asha" } }, { ...returns, canAdd: false });
  check(
    "rows are not added to a store list",
    store.ask === null && store.left.includes("rows are not added to Returns here")
  );
}

console.log("\nthe link their own AI hands them");
{
  const { ask } = read({ filters: { status: "Requested" }, add: { customer_name: "Asha & Co / #1" } });
  const href = screenHref("p-1", ask);
  const url = new URL(href, "https://app.example");
  check("opens the section", url.pathname === "/app/p-1" && url.searchParams.get("section") === "m-returns");
  const back = read(screenFromHref(url.searchParams.get("show")));
  check("and reads back as it was", JSON.stringify(back.ask) === JSON.stringify(ask));
  check("an address that is not one is nothing", screenFromHref("{nope") === null && screenFromHref(null) === null);
  check("nor a huge one", screenFromHref(`"${"x".repeat(5000)}"`) === null);
}

console.log("\nLuke's answer: read by code, the receipt the code's");
{
  const open = { id: "m-returns", nav_label: "Returns", source_table: null };
  const raw = JSON.stringify({
    type: "answer",
    kind: "conversation",
    message: "Showing returns waiting.",
    show: { filters: { status: "Requested", courier: "x" } },
  });
  const shown = shownOnScreen(raw, open, schema);
  check("what holds is kept", shown.filters.status === "Requested" && shown.moduleId === "m-returns");
  check("with its words", shown.said === "Returns: Status: Requested");
  check("and what did not, to say", shown.left?.[0] === "Returns has no courier filter");
  check("no show, nothing", shownOnScreen('{"type":"answer","message":"Hi"}', open, schema) === null);
  const none = shownOnScreen(
    JSON.stringify({ type: "answer", message: "x", show: { filters: { courier: "x" } } }),
    open,
    schema
  );
  check("nothing that holds: nothing done, and said", none.said === "" && none.left.length === 1);
  check(
    "a store list takes no row",
    shownOnScreen(
      JSON.stringify({ type: "answer", message: "x", show: { add: { customer_name: "A" } } }),
      { ...open, source_table: "orders" },
      schema
    ).said === ""
  );
}

console.log("\nwith a section open, which road");
const road = (message, open = true) => roadFor({ message, lastReplyType: null, routed: false, open });
for (const m of [
  "sirf COD wale dikhao",
  "filter by Pending",
  "newest first",
  "pending ones first",
  "find Ravi's orders",
  "Asha ka return add karo, order #1042, size chhota",
  "Hi\nMera order 1042 ka size chhota hai\nReturn chahiye\n- Asha",
  "can you add this return: Asha, #1042, damaged",
]) {
  check(`talk: "${m.replace(/\n/g, " / ")}"`, road(m) === "talk");
}
for (const m of [
  "add a filter for COD",
  "add a column for courier",
  "make a board view of returns",
  "remove the Reason filter",
  "rename Status to Stage",
  "add returns tracking",
  "show a button to mark them received and add it",
]) {
  check(`design: "${m}"`, road(m) === "design");
}
check(
  "nothing open: as before",
  road("sirf COD wale dikhao", false) === "design" && road("filter by Pending", false) === "design"
);
check(
  "an answer to Luke's question is still the design's",
  roadFor({ message: "filter by\n→ Pending", lastReplyType: "clarify", routed: false, open: true }) === "design"
);

console.log(fails.length === 0 ? "\nLuke does on the screen only what the section has" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
