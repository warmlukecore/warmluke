// No limit drops data silently (docs/reference/limits.md).
//
// A rule read the first 500 of 2,058 rows and wrote nothing; Luke was
// shown the 15 lowest stock rows and said "15 out of stock" of 311. Every
// `.limit(` in src/ is therefore either in the registry, which says who is
// told when it cuts, or carries a `limit:` comment on its line or the one
// above saying so. A new one with neither fails here, before it ships.
//
//   node scripts/check-limits.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

/** Each `.limit(…)` on a line, its argument as written; one row (`1`) is not a limit worth naming. */
function limitsIn(line) {
  const out = [];
  let at = line.indexOf(".limit(");
  while (at >= 0) {
    let depth = 0;
    let arg = "";
    let j = at + ".limit".length;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === "(" && ++depth === 1) continue;
      if (c === ")" && --depth === 0) break;
      arg += c;
    }
    if (arg.trim() && arg.trim() !== "1") out.push(arg.trim());
    at = line.indexOf(".limit(", j);
  }
  return out;
}

const registry = new Set(
  readFileSync(join(root, "docs/reference/limits.md"), "utf8")
    .split("\n")
    .map((l) => /^\|\s*`(src\/[^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(l))
    .filter(Boolean)
    .map((m) => `${m[1]}|${m[2]}`)
);

const fails = [];
const seen = new Set();
for (const file of walk(join(root, "src"))) {
  const rel = file.slice(root.length);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const arg of limitsIn(line)) {
      const key = `${rel}|${arg}`;
      seen.add(key);
      const marked = /limit:/.test(line) || /limit:/.test(lines[i - 1] ?? "");
      if (!registry.has(key) && !marked) fails.push(`${rel}:${i + 1}  .limit(${arg})`);
    }
  });
}

const check = (name, ok) => console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
check(`every row limit in src/ says who is told when it cuts (${seen.size} found)`, fails.length === 0);
for (const f of fails)
  console.log(`     → ${f}: add it to docs/reference/limits.md, or mark it with a "limit:" comment`);
// Gone from the code but still listed: a note, not a failure, so a moved line never blocks anyone.
const stale = [...registry].filter((k) => !seen.has(k));
if (stale.length) console.log(`  note  listed but no longer in src/: ${stale.join(", ")}`);
console.log(fails.length === 0 ? "\nno limit cuts without a word" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
