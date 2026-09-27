// The critic's verdict, read back.
//
// A design that passed every gate is read once more against what was
// asked; the reply is a verdict in a JSON shape. This holds the reader
// to it. Pure: no model, no database.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-critic.mjs

import { parseCritique } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("a verdict read back");
const back = parseCritique(
  '{"unmet":["scan orders as I pack them"],"redo":"Add a scan bar on order_number that ticks packed."}'
);
check(
  "what is missing, and the line that sends it back",
  back?.unmet.length === 1 && /scan bar/.test(back?.redo ?? "")
);
const fits = parseCritique('```json\n{"unmet": [], "redo": null}\n```');
check("nothing missing, nothing sent back — fenced too", !!fits && fits.unmet.length === 0 && fits.redo === null);
check("an empty redo is no redo", parseCritique('{"unmet":["x"],"redo":"  "}')?.redo === null);
check(
  "unmet is cut to four",
  parseCritique(JSON.stringify({ unmet: ["a", "b", "c", "d", "e", "f"] }))?.unmet.length === 4
);
check("not JSON, no verdict", parseCritique("The design looks fine to me.") === null);
check("a list, no verdict", parseCritique("[1,2]") === null);

console.log(fails.length === 0 ? "\nthe critic's word is read back as given" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
