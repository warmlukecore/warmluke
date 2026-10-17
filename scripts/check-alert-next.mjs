// What comes after an alert (lib/alert-next): its next step, whose job it
// is by the team's own answers, and what Luke found looking into RTO.
//
// Pure: every kind Luke watches has a next step that is the owner's to
// take, never one Luke takes on his own; "me" is the owner; nobody named
// is said as nothing, not guessed; RTO's finding names the worst groups
// with their counts and leaves out the ones too small to say.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-alert-next.mjs
import { foundOf, lookedIntoRto, nextOf, whoOf } from "../src/lib/alert-next.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the next step");
const KINDS = [
  "low_stock",
  "dispatch_late",
  "returns_spike",
  "return_reason",
  "rto_rising",
  "ads_no_sales",
  "ads_low_stock",
];
check(
  "every kind Luke watches has one",
  KINDS.every((k) => (nextOf({ kind: k }) ?? "").length > 10)
);
check("a kind of their own has none", nextOf({ kind: "rule" }) === null);
check(
  "a restock time, when said, is in it",
  nextOf({ kind: "low_stock", facts: { lead_days: 10 } }) === "Reorder now: a restock takes 10 days"
);
check("and asked for when not", /say how long a restock takes/.test(nextOf({ kind: "low_stock", facts: {} })));
check("an ad's budget stays the owner's", /yours to change/.test(nextOf({ kind: "ads_no_sales" })));
check(
  "and on stock running out, with the restock time when said",
  nextOf({ kind: "ads_low_stock", facts: { lead_days: 12 } }) ===
    "Reorder what it sells (a restock takes 12 days), or move its spend to what is in stock; its budget is yours to change"
);

console.log("\nwhose job it is");
const team = { packing: "Ravi", customers: "Me", ads: "", restocking: "Sunita" };
check(
  "by the team's own answer",
  whoOf("dispatch_late", team) === "Ravi handles this" && whoOf("low_stock", team) === "Sunita handles this"
);
check("“me” is the owner", whoOf("returns_spike", team) === "Yours to handle");
check("nobody named, nothing said", whoOf("ads_no_sales", team) === null && whoOf("rto_rising", null) === null);

console.log("\nwhat Luke found looking into RTO");
const payment = {
  groups: [
    { name: "COD", rto: 21, settled: 50, rate: 42, change: 30 },
    { name: "Prepaid", rto: 3, settled: 40, rate: 7.5, change: -1 },
    { name: "Unknown payment", rto: 2, settled: 30, rate: 6.7, change: null },
  ],
};
const state = {
  groups: [
    { name: "Bihar", rto: 12, settled: 22, rate: 54.5, change: null },
    { name: "Goa", rto: 1, settled: 3, rate: null, change: null },
  ],
};
const line = lookedIntoRto(payment, state);
check(
  "the worst groups first, with their counts and how far they moved",
  line ===
    "Luke looked into it: Bihar 54.5% (12 of 22) · COD 42% (21 of 50), up 30 points · Prepaid 7.5% (3 of 40), down 1 point"
);
check("a group too small to say is left out", !line.includes("Goa"));
check("and so is one with no name", !line.includes("Unknown"));
check("nothing settled enough, said so", /too few shipments settled/.test(lookedIntoRto({ groups: [] }, null)));

console.log("\nwhat the watch recorded (0230)");
check(
  "read from the alert's own facts, as it was found",
  foundOf({ kind: "rto_rising", facts: { by_payment: payment, by_state: state } }) === line
);
check(
  "none recorded, nothing said, never a guess",
  foundOf({ kind: "rto_rising", facts: { rate: 30 } }) === null && foundOf({ kind: "low_stock", facts: {} }) === null
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nan alert says what to do next, and whose it is");
process.exit(fails.length ? 1 : 0);
