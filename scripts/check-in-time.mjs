// Work that answers in time if it can, and finishes anyway if it cannot
// (lib/in-time): what propose_change does with a long design, so a
// client that stops waiting no longer throws the design away. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-in-time.mjs

import { inTime } from "../src/lib/in-time.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

console.log("\nwork that is quick");
let handed = null;
const quick = await inTime(after(10, "design"), 200, (rest) => (handed = rest));
check("answers with it", quick === "design");
check("and hands nothing on", handed === null);

console.log("\nwork that is not");
let rest = null;
const slow = await inTime(after(150, "late design"), 20, (r) => (rest = r));
check("answers that it is still going", slow === null);
check("and hands the rest on, which still finishes", (await rest) === "late design");

console.log("\nwork that fails in time");
const failed = await inTime(Promise.reject(new Error("no design")), 200, () => {}).then(
  () => "resolved",
  (e) => e.message
);
check("fails as if awaited", failed === "no design");

console.log(fails.length === 0 ? "\nwork answers in time, or finishes anyway" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
