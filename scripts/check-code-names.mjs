// A rule's code finds the sections it reads however it spells them
// (lib/code-run RUNNER, lib/code-rules sectionKey / placeFor).
//
// "Pass packing to Orders" was told to use sections["#orders"], wrote
// sections.orders and section: "orders", and so on every scan it read no
// orders, matched none and wrote nothing, with no error anywhere
// (2026-09-30). Its code, as it stands, is run here through the same
// runner the sandbox runs, in a plain node process: nothing is paid. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-code-names.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIASES, RUNNER } from "../src/lib/code-run.ts";
import { placeFor } from "../src/lib/code-rules.ts";
import { findSection, sectionKey } from "../src/lib/section-ref.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** The runner, on these inputs, as the sandbox runs it. */
function runHere(code, inputs) {
  const dir = mkdtempSync(join(tmpdir(), "code-names-"));
  try {
    writeFileSync(join(dir, "rule.mjs"), code);
    writeFileSync(join(dir, "runner.mjs"), RUNNER);
    writeFileSync(join(dir, "inputs.json"), JSON.stringify(inputs));
    return JSON.parse(execFileSync(process.execPath, ["runner.mjs"], { cwd: dir, encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The rule's code as Luke wrote it, the parts that matter word for word.
const PASS_PACKING = `export default function run({ row, previous, sections, today, now }) {
  const order = (sections.orders || []).find(o => o.order_number === row.order_number);
  if (!order) return { set: [] };
  const p = previous || {};
  const f = {};
  if (p.pack_event !== row.pack_event && row.pack_event === 'Packed') {
    f.packed = true; f.packed_by = row.event_by || ''; f.packed_on = today;
  }
  return { set: Object.keys(f).length ? [{ id: order.id, section: 'orders', fields: f }] : [] };
}`;
const aliases = { orders: "#orders", [sectionKey("a013677f-fb16-4ee2-bb4b-8e45de1e594c")]: "#orders" };
const input = {
  row: { id: "line-1", order_number: "#1303", pack_event: "Packed", event_by: "aman" },
  previous: { pack_event: null },
  sections: { "#orders": [{ id: "order-1303", order_number: "#1303" }] },
  [ALIASES]: aliases,
  today: "2026-09-30",
  now: "2026-09-30T12:14",
};

console.log("a rule's code reads a section by the name it uses");
const [ran] = runHere(PASS_PACKING, [input]);
const set = ran?.out?.set ?? [];
check("sections.orders is the section listed as #orders", ran?.ok && set.length === 1 && set[0].id === "order-1303");
check("and it packs the order the scan named", set[0]?.fields?.packed === true && set[0]?.fields?.packed_by === "aman");
const spelled = runHere(
  `export default function run({ sections }) { return { set: [{ id: "x", fields: { n: sections["#orders"].length + sections.Orders.length + ("orders" in sections ? 1 : 0) } }] }; }`,
  [input]
)[0];
check("as #orders, as Orders and to `in`, the same rows", spelled?.out?.set?.[0]?.fields?.n === 3);
const keys = runHere(
  `export default function run({ sections, ...rest }) { return { set: [{ id: "x", fields: { k: Object.keys(sections).join(","), extra: Object.keys(rest).join(",") } }] }; }`,
  [input]
)[0];
check(
  "the names ride beside the rows, and the code never sees them",
  keys?.out?.set?.[0]?.fields?.k === "#orders" && !String(keys?.out?.set?.[0]?.fields?.extra).includes(ALIASES)
);

console.log("\na write lands on the section it names, however spelled");
const read = { places: { "#orders": { moduleId: "orders-module", table: "orders" } }, aliases };
check('section: "orders"', placeFor(read, "orders")?.moduleId === "orders-module");
check('section: "#orders"', placeFor(read, "#orders")?.moduleId === "orders-module");
check('section: "Orders"', placeFor(read, "Orders")?.moduleId === "orders-module");
check("and one it does not read lands nowhere", placeFor(read, "#customers") === null);
check(
  "Courier Rates, courier-rates and #courier_rates are one name",
  new Set(["Courier Rates", "courier-rates", "#courier_rates"].map(sectionKey)).size === 1
);

console.log("\na build, a screen and a rule find a section the same way (lib/section-ref)");
const sections = [
  { id: "m-1", name: "orders", nav_label: "Orders" },
  { id: "m-2", name: "packing-scan", nav_label: "Packing Scan" },
  { id: "m-3", name: "order_lines", nav_label: "Order lines" },
];
check("by its id", findSection(sections, "m-2")?.id === "m-2");
check(
  "by its name, with or without #",
  findSection(sections, "#orders")?.id === "m-1" && findSection(sections, "orders")?.id === "m-1"
);
check("by its label", findSection(sections, "#Packing Scan")?.id === "m-2");
check(
  "and by the spellings between",
  findSection(sections, "#order-lines")?.id === "m-3" && findSection(sections, "Order Lines")?.id === "m-3"
);
check("a name that is no section finds none", findSection(sections, "#customers") === undefined);

console.log(fails.length === 0 ? "\na rule finds its sections by any of their names" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
