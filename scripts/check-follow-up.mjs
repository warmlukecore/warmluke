// A spreadsheet of the admin screens runs nothing it was not meant to,
// and a demo request's stages are the database's.
//
// The demo rows were typed by anyone holding the public key, so the file
// an administrator downloads must not turn a name into a formula. And
// the stages the screen offers must be the ones 0120's check accepts,
// or a click saves nothing but an error.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-follow-up.mjs

import { readFileSync } from "node:fs";
import { toCsv } from "../src/lib/csv.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the file a spreadsheet opens");
{
  const one = (v) => toCsv([{ v }], [["h", (r) => r.v]]).split("\r\n")[1];
  check("a formula is written as text", one("=HYPERLINK(\"http://x\",\"a\")") === `"'=HYPERLINK(""http://x"",""a"")"`);
  check("so are + - and @", one("+1") === "'+1" && one("-2+3") === "'-2+3" && one("@SUM(A1)") === "'@SUM(A1)");
  check("and a tab or return in front of one", one("\t=1") === "'\t=1" && one("\r=1") === `"'\r=1"`);
  check("a negative number stays a number", one(-3) === "-3");
  check("a comma, a quote or a new line is quoted", one("a,b") === '"a,b"' && one('say "hi"') === '"say ""hi"""' && one("a\nb") === '"a\nb"');
  check("nothing is an empty cell", one(null) === "" && one(undefined) === "");
  check("true and false are words", one(true) === "true" && one(false) === "false");
  const file = toCsv([{ a: "x", b: 1 }, { a: "y", b: 2 }], [["A", (r) => r.a], ["B", (r) => r.b]]);
  check("a header, then one line a row", file === "A,B\r\nx,1\r\ny,2");
  check("no rows is still the header", toCsv([], [["A", () => 1]]) === "A");
}

console.log("\nthe stages are the database's");
{
  const sql = readFileSync(new URL("../supabase/migrations/0120_following_up_and_the_whole_story.sql", import.meta.url), "utf8");
  const parts = readFileSync(new URL("../src/components/AdminParts.tsx", import.meta.url), "utf8");
  const lists = [...sql.matchAll(/stage[^\n]*in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).join(","));
  const block = parts.slice(parts.indexOf("export const DEMO_STAGES"), parts.indexOf("];", parts.indexOf("export const DEMO_STAGES")));
  const screen = [...block.matchAll(/value: "([a-z_]+)"/g)].map((m) => m[1]).join(",");
  const tones = parts.slice(parts.indexOf("export const STAGE_TONE"), parts.indexOf("};", parts.indexOf("export const STAGE_TONE")));
  check("the table and the function accept the same stages", lists.length === 2 && lists[0] === lists[1]);
  check("the screen offers exactly those, in order", screen === lists[0]);
  check("and every one has a badge", screen.split(",").every((v) => new RegExp(`\\b${v}:`).test(tones)));
  check("a request nobody has touched is new", /coalesce\(f\.stage, 'new'\)/.test(sql) && screen.startsWith("new,"));
}

console.log(fails.length === 0 ? "\nthe follow-ups say what they are" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
