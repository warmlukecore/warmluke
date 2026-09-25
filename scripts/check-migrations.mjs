// The migrations directory, as a thing that can be wrong.
//
// Seventy-eight files applied by hand, in order, by reading their
// numbers. Two files with the same number would apply in whatever
// order the filesystem felt like; a gap would be a migration somebody
// wrote and never committed. Nothing checked either. This does, and
// it needs no database, so it runs on every push.
//
//   node scripts/check-migrations.mjs

import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const numbered = files.map((f) => ({ f, n: /^(\d{4})_/.exec(f)?.[1] }));

console.log("every migration is named for its place in line");
check(
  "all of them are NNNN_name.sql",
  numbered.every((x) => x.n !== undefined)
);
const nums = numbered.map((x) => x.n).filter(Boolean);
const dups = nums.filter((n, i) => nums.indexOf(n) !== i);
check("no two share a number", dups.length === 0);
if (dups.length) console.log("     →", [...new Set(dups)].join(", "));
const gaps = nums
  .slice(1)
  .map((n, i) => [nums[i], n])
  .filter(([a, b]) => Number(b) - Number(a) !== 1);
check("and there are no gaps", gaps.length === 0);
if (gaps.length) console.log("     →", gaps.map(([a, b]) => `${a}→${b}`).join(", "));

console.log("\nand each one says something");
const empty = numbered.filter((x) => readFileSync(new URL(x.f, dir), "utf8").trim().length === 0).map((x) => x.f);
check("none is empty", empty.length === 0);
// A function redefined without telling PostgREST is a function the
// API keeps calling by its old signature. Every file that replaces one
// has ended with the notify so far; keep it that way.
const forgetful = numbered
  .filter((x) => {
    const src = readFileSync(new URL(x.f, dir), "utf8");
    return /create or replace function/i.test(src) && !/notify pgrst/i.test(src);
  })
  .map((x) => x.f);
check("every one that redefines a function tells PostgREST", forgetful.length === 0);
if (forgetful.length) console.log("     →", forgetful.slice(0, 5).join(", "));

console.log(fails.length === 0 ? `\n${files.length} migrations, in order` : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
