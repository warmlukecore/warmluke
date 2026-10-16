// What Luke may do in an app (lib/luke-may, 0223): one row a thing he can
// do, each on, asking first, off, or waiting for a connection, as it is.
//
// Pure. The standing yes itself (only the owner gives it, only their own
// talk with Luke uses it, taken back at once) is checked live in
// check-row-asks.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-luke-may.mjs
import { MAY_LABEL, lukeMay } from "../src/lib/luke-may.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const row = (rows, what) => rows.find((r) => r.what.startsWith(what));

console.log("\nwhat Luke may do");
const fresh = lukeMay({ store: false, granted: [], shop: { on: false, auto: 0 }, watching: 0 });
check("with no store, reading it needs one", row(fresh, "Read your store").state === "needs");
check("building always asks first", row(fresh, "Build or change").state === "asks");
check("changing rows asks first until they say otherwise", row(fresh, "Change values").state === "asks");
check("the shop needs a connection", row(fresh, "Change your Shopify").state === "needs");
check("nothing watched is off", row(fresh, "Watch your store").state === "off");
check("their own AI only ever asks", row(fresh, "Your own AI").state === "asks");

const busy = lukeMay({ store: true, granted: ["Orders", "Blanks"], shop: { on: true, auto: 1 }, watching: 3 });
check("a store connected is read", row(busy, "Read your store").state === "on");
check(
  "a standing yes names its sections",
  row(busy, "Change values").state === "on" && row(busy, "Change values").says.includes("Orders, Blanks")
);
check("a kind that goes on its own is said", row(busy, "Change your Shopify").says.startsWith("1 kind of change"));
check("what is watched is counted", row(busy, "Watch your store").says === "Watching 3 things.");
check(
  "shop changes turned off say so",
  row(lukeMay({ store: true, granted: [], shop: { on: false, auto: 0 }, watching: 0 }), "Change your Shopify").state ===
    "off"
);
check(
  "every state has words",
  busy.concat(fresh).every((r) => !!MAY_LABEL[r.state] && r.says.length > 5)
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nwhat Luke may do is said as it is");
process.exit(fails.length ? 1 : 0);
