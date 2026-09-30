// Every call the browser makes to our own API carries the owner's token.
//
// "Roll back to this" called /api/rollback with a bare fetch and no
// Authorization header, so a signed-in owner was told "Not signed in."
// (2026-09-30). The API reads the token from that header and nothing else,
// so a call without it is refused whoever makes it. apiFetch (lib/auth)
// attaches it; a call made by hand must attach it itself. Pure: it reads
// the source.
//
//   node scripts/check-api-signed.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** Endpoints anyone may call, signed in or not. */
const OPEN = [/^\/api\/shopify\/start\?check=1/];

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "api") walk(p);
    } else if (/\.(tsx?|mjs)$/.test(f)) files.push(p);
  }
};
walk(new URL("../src", import.meta.url).pathname);

console.log("every browser call to our API is signed");
let calls = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  // A server route's own fetches go elsewhere; only the browser's side is read.
  if (!/["']use client["']/.test(src) && !/\/lib\/(auth|one-tap)\.ts$/.test(file)) continue;
  for (const m of src.matchAll(/fetch\(\s*[`"'](\/api\/[^`"']*)/g)) {
    calls++;
    const path = m[1];
    if (OPEN.some((re) => re.test(path))) continue;
    const call = src.slice(m.index, m.index + 400);
    const line = src.slice(0, m.index).split("\n").length;
    check(`${file.replace(/^.*\/src\//, "src/")}:${line} ${path} carries the token`, /Authorization/.test(call));
  }
}
check("and there are calls to read", calls > 0);

console.log(fails.length === 0 ? "\nno call to our API goes unsigned" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
