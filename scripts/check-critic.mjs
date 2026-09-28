// The critic's verdict, read back.
//
// A design that passed every gate is read once more against what was
// asked; the reply is a verdict in a JSON shape. This holds the reader
// to it. Pure: no model, no database.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-critic.mjs

import { parseCritique } from "../src/lib/ai.ts";
import { describePlan } from "../src/lib/describe.ts";
import { describeBuild } from "../src/lib/judge.ts";

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

// A written screen is judged by what it does, and its code is what it
// does: the critic read only its words, and named the scanning and the
// "next by itself" the screen did as missing (the packing eval).
console.log("\nwhat the critic reads of a written screen");
const station = {
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: { name: "packing", nav_label: "Packing", icon: "table", source_table: "order_line_items" },
  newSchema: { columns: [{ field: "scanned_qty", label: "Scanned", type: "number" }] },
  features: {
    view: {
      type: "custom",
      title: "Packing station",
      html: "<div class=wl-page>Scan the order</div><style>.x{color:red}</style><script>async function onScan(v){ await wl.set(id,{scanned_qty:n}); nextLine(); }</script>",
    },
  },
  explanation: "A packing screen.",
};
const forCritic = describeBuild([station], [], undefined, null, { screens: true });
check(
  "the critic is handed the screen's code",
  forCritic.includes("wl.set(id,{scanned_qty:n})") && forCritic.includes("nextLine()")
);
check("without its styling", !forCritic.includes("color:red"));
check("the judge is not, by default", !describeBuild([station], []).includes("wl.set("));
check("and neither is the owner's card", !JSON.stringify(describePlan(station, [])).includes("wl.set("));

console.log(fails.length === 0 ? "\nthe critic's word is read back as given" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
