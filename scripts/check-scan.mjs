// What a scan matches, and when a group it opened is done (lib/scan).
//
// A code is the same code whatever its case, spaces or leading "#": a
// label printed "1304" opens order "#1304". An item matches by its SKU
// or any other code the section lets it match. A group is done only
// when every one of its rows is, and an empty group never is.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-scan.mjs

import { codeSpellings, groupDone, rowsFor, sameCode } from "../src/lib/scan.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the same code");
check('"#1304" and "1304" are one order', sameCode("#1304", "1304") && sameCode(" 1304 ", "#1304"));
check("case does not make another SKU", sameCode("cf-0055-1", "CF-0055-1"));
check("but a different code is different", !sameCode("CF-0055-1", "CF-0055-2") && !sameCode("#1304", "#13041"));
check("and nothing is never a match", !sameCode("", "") && !sameCode(null, undefined));
check(
  "the database is asked for every spelling a label may be kept under",
  codeSpellings("1304").join() === "1304,#1304" && codeSpellings("#1304").join() === "#1304,1304"
);

const row = (id, data) => ({ id, project_id: "p", module_id: "m", data, created_at: "", updated_at: "" });
const lines = [
  row("a", { order_number: "#2001", sku: "CF-1", maker: "8901", qty: 1, scanned: 1 }),
  row("b", { order_number: "#2001", sku: "CF-2", maker: "8902", qty: 2, scanned: 1 }),
];

console.log("\nan item, by any code it carries");
check(
  "by its SKU",
  rowsFor(lines, "cf-2", ["sku"])
    .map((r) => r.id)
    .join() === "b"
);
check(
  "or by the maker's code when the section lets it",
  rowsFor(lines, "8901", ["sku", "maker"])
    .map((r) => r.id)
    .join() === "a"
);
check("and not by a field it was not told to look at", rowsFor(lines, "8901", ["sku"]).length === 0);

console.log("\na group is done when every row is");
const done = { op: ">=", args: [{ field: "scanned" }, { field: "qty" }] };
check("one line still short: not done", !groupDone(lines, done));
check("every line scanned: done", groupDone([lines[0], { ...lines[1], data: { ...lines[1].data, scanned: 2 } }], done));
check("an empty group is never done", !groupDone([], done));

console.log(
  fails.length === 0
    ? "\na scan matches what it should, and a group ends when every line does"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
