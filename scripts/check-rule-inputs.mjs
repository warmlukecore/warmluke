// What a rule's code is handed, and how much (lib/code-run packInputs,
// namesIn, RUNNER, parseResult; 0206).
//
// A rule now reads every row of a section, so the input must stay small
// enough to hand over: the sections every input shares go once (a store
// bringing in fifty orders sent the same stock list fifty times), each input
// still gets its own copy to sort or trim, and only when the whole would not
// fit are rows slimmed to the fields the code names — never when the code
// reads rows whole. Writes past what one run may make are counted, not lost
// without a word. The runner is run here in a plain node process. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-rule-inputs.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDS_MAX, INPUT_MAX, RUNNER, SETS_MAX, namesIn, packInputs, parseResult } from "../src/lib/code-run.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** The runner on this packed input, as the sandbox runs it. */
function runHere(code, packed) {
  const dir = mkdtempSync(join(tmpdir(), "rule-inputs-"));
  try {
    writeFileSync(join(dir, "rule.mjs"), code);
    writeFileSync(join(dir, "runner.mjs"), RUNNER);
    writeFileSync(join(dir, "inputs.json"), packed);
    return JSON.parse(execFileSync(process.execPath, ["runner.mjs"], { cwd: dir, encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Tanish's sync, as Luke wrote it (11 Oct).
const SYNC = `export default function run({ row, sections }) { var stockRows = sections.stock || []; var set = []; for (var i=0;i<stockRows.length;i++){ var s = stockRows[i]; if (s.parent_sku === row.parent_sku) { set.push({ id: s.id, fields: { parent_available: row.total_available }, section: 'stock' }); } } return { set: set }; }`;

console.log("the names the code reaches a field by");
const names = namesIn(SYNC);
check("every word it uses", names?.has("parent_sku") && names.has("total_available") && !names.has("title"));
check(
  "none when it reads rows whole",
  namesIn("export default function run({ rows }) { return Object.keys(rows[0]); }") === null
);
check(
  "nor when it spreads one",
  namesIn("export default function run({ row }) { const r = { ...row }; return {}; }") === null
);
check(
  "nor when it walks one's keys",
  namesIn("export default function run({ row }) { for (const k in row) {} return {}; }") === null
);

console.log("\nwhat goes into the machine");
const stock = Array.from({ length: 3 }, (_, i) => ({
  id: `s${i}`,
  parent_sku: i < 2 ? "POX-SL" : "OTHER",
  title: "x",
}));
const sections = { "#stock": stock };
// Each section comes with the other names it may be asked for by (lib/code-rules readSections).
const __names = { stock: "#stock" };
const inputs = [0, 1, 2].map((i) => ({ row: { id: `p${i}`, parent_sku: "POX-SL" }, sections, __names }));
const packed = JSON.parse(packInputs(SYNC, inputs));
check("the sections every input shares go once", !!packed.sections && packed.inputs.every((i) => !("sections" in i)));
check("whole, while they fit", packed.sections["#stock"][0].title === "x");
const one = JSON.parse(packInputs(SYNC, [inputs[0]]));
check("one input carries its own", !one.sections && one.inputs[0].sections["#stock"].length === 3);

// A list too big to hand over whole: 40,000 rows with a long field the code never names.
const big = Array.from({ length: 40_000 }, (_, i) => ({
  id: `r${i}`,
  parent_sku: i % 1000 === 0 ? "POX-SL" : `SKU-${i}`,
  description: "a long description nobody's code reads ".repeat(8),
}));
const bigInput = [
  { row: { id: "p", parent_sku: "POX-SL", total_available: 500 }, sections: { "#stock": big }, __names },
];
check("a list past the limit would not fit whole", JSON.stringify(bigInput).length > INPUT_MAX);
const lean = packInputs(SYNC, bigInput);
check("slimmed to the fields the code names, it does", lean !== null && lean.length <= INPUT_MAX);
const leanRow = JSON.parse(lean).inputs[0].sections["#stock"][1];
check(
  "with each row's id and its named fields only",
  leanRow.id === "r1" && leanRow.parent_sku === "SKU-1" && !("description" in leanRow)
);
check(
  "and code that reads rows whole is not slimmed: it is asked to read less",
  packInputs("export default function run({ sections }) { return { set: Object.keys(sections) }; }", bigInput) === null
);

console.log("\nthe runner");
const ran = runHere(SYNC, packInputs(SYNC, inputs));
check("each input runs on the shared sections", ran.length === 3 && ran.every((r) => r.ok && r.out.set.length === 2));
const SORTS = `export default function run({ row, sections }) { const l = sections["#stock"]; l.sort((a, b) => (a.id < b.id ? 1 : -1)); const first = l[0].id; l.length = 0; return { set: [{ id: first, fields: { at: row.id } }] }; }`;
const sorted = runHere(SORTS, packInputs(SORTS, inputs));
check(
  "and one input's sorting or emptying a list never reaches the next",
  sorted.every((r) => r.ok && r.out.set[0].id === "s2")
);
check(
  "a plain list of inputs still runs as before",
  runHere(SYNC, JSON.stringify(inputs)).every((r) => r.ok && r.out.set.length === 2)
);
const LIVE_BIG = runHere(SYNC, lean);
check(
  "and a slimmed list runs the sync it was slimmed for",
  LIVE_BIG[0]?.ok && LIVE_BIG[0].out.set.length === 40 && LIVE_BIG[0].out.set[0].fields.parent_available === 500
);

console.log("\nwhat comes back");
const many = parseResult({
  set: Array.from({ length: SETS_MAX + 12 }, (_, i) => ({ id: `r${i}`, fields: { a: 1 } })),
  add: Array.from({ length: ADDS_MAX + 3 }, () => ({ fields: { b: 1 } })),
});
check(
  "writes past what a run may make are counted",
  many.set.length === SETS_MAX && many.add.length === ADDS_MAX && many.dropped === 15
);
check("and none past it say nothing", !("dropped" in parseResult({ set: [{ id: "a", fields: {} }] })));

console.log(fails.length ? `\n${fails.length} FAILED` : "\na rule is handed all it reads, in a size that fits");
process.exit(fails.length ? 1 : 0);
