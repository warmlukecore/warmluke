// Every icon a section can be given is one the app can draw.
//
// A section stores its icon by name: one the designer may choose
// (ALLOWED_ICONS in lib/types) or one a store section is born with
// (lib/store-read). The sidebar draws the name through one map in
// components/ui/Icon.tsx, and a name missing from it falls back to a
// plain table without a word. Returns, discounts and draft orders all
// wore that table before anyone looked.
//
//   node scripts/check-icons.mjs

import { readFileSync } from "node:fs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const map = read("src/components/ui/Icon.tsx");
const mapAt = map.indexOf("SECTION_ICONS");
const body = map.slice(mapAt, map.indexOf("};", mapAt));
const drawn = new Set([...body.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*[A-Z]/gm)].map((m) => m[1]));

const types = read("src/lib/types.ts");
const allowedAt = types.indexOf("export const ALLOWED_ICONS");
const allowed = [...types.slice(allowedAt, types.indexOf("]", allowedAt)).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
const store = [...new Set([...read("src/lib/store-read.ts").matchAll(/section: \{[^}]*icon: "([a-z0-9-]+)"/g)].map((m) => m[1]))];

console.log("every icon a section can have is drawn");
check(`the map draws ${drawn.size} names`, drawn.size > 0);
const notAllowed = allowed.filter((n) => !drawn.has(n));
check(`all ${allowed.length} a designer may choose`, allowed.length > 0 && notAllowed.length === 0);
if (notAllowed.length) console.log("     →", notAllowed.join(", "));
const notStore = store.filter((n) => !drawn.has(n));
check(`all ${store.length} the store's own sections use`, store.length > 0 && notStore.length === 0);
if (notStore.length) console.log("     →", notStore.join(", "));

console.log(fails.length === 0 ? "\nno section falls back to a table it did not ask for" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
