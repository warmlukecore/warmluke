// Internal ids never reach the screen.
//
// Text the app does not write itself — what Luke says, a validator's
// error, a row described by its fields — carried uuids onto the screen.
// What is shown passes through lib/no-ids: an id with a known name
// reads as the name, any other is taken out, with what it left behind.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-no-ids.mjs

import { isId, withoutIds } from "../src/lib/no-ids.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const PACKING = "7ac0b1e5-0000-4000-8000-00000000c0de";
const names = new Map([[PACKING, "Packing"]]);
const some = "50ad13a1-9a86-40fe-a478-f2362571fecf";

console.log("what is shown carries no ids");
check(
  "a section as the model is told it reads as its name",
  withoutIds(`Packing [id ${PACKING}]: packed`, names) === "Packing: packed"
);
check("an id with a known name reads as the name", withoutIds(`Added to ${PACKING}.`, names) === "Added to Packing.");
check("any other id is taken out", !withoutIds(`No section has the id "${some}".`, names).includes(some));
check("with the empty quotes it leaves", withoutIds(`No section has the id "${some}".`) === "No section has the id .");
check("and the separators beside it", withoutIds(`${some} · 019829b7-7693-4031-be15-50ab9c3de3ab · #1304`) === "#1304");
check("in upper case too", !withoutIds(some.toUpperCase()).includes(some.toUpperCase()));
check(
  "text without an id is left exactly as it was",
  withoutIds("Order #1304 · 2 pieces") === "Order #1304 · 2 pieces"
);
check("an id alone is one", isId(some) && isId(` ${some} `));
check("an order number is not", !isId("#1304") && !isId("CF-0086-2") && !isId(42));

console.log(fails.length === 0 ? "\nno internal id is shown to anyone" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
