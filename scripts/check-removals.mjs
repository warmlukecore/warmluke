// A section can be asked for, and only ever removed by hand.
//
// Removing a section takes every row in it and does not come back.
// The confirmation that guards it is typing the section's name, and a
// chat window cannot ask for that — so a connected assistant may
// PROPOSE a removal and may never build one.
//
// That used to be enforced by refusing the request outright, which
// made "delete the Variants section" a dead end with nothing for the
// merchant to act on. The request is allowed now, which moves the
// whole weight of the guarantee onto three places. This is a source
// check on purpose: what it is protecting is the absence of a path,
// and an absence is not something a request can demonstrate.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-removals.mjs

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mcp = read("src/app/api/mcp/route.ts");
const panel = read("src/components/ChatPanel.tsx");
const build = read("supabase/migrations/0085_one_list_of_store_tables.sql");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("a removal may be asked for");
// The refusal that used to sit in propose_change. Its return left the
// merchant a sentence and no card.
check(
  "proposing one is not refused",
  !/Removing a section cannot be done from here/.test(mcp)
);
check("the design still says which sections would go", /const gone = removals\(plans\);/.test(mcp));

console.log("\nand never built without a person");
// The one that matters most: auto-build is a standing yes to ordinary
// changes, and a standing yes must not reach this one.
check(
  "auto-build cannot reach it",
  /const automatic = wantsAuto && autoReason === null && gone\.length === 0;/.test(mcp)
);
check(
  "approving from chat still refuses",
  /This design removes a section, which cannot be built from here/.test(mcp)
);
// Belt and braces, and the only one an attacker cannot argue with:
// the database refuses the write whatever the route believes.
check(
  "the database refuses it to any client",
  /if p_op = 'module_delete' then\s*\n\s*raise exception 'Removing a section has to be done in Warmluke\./.test(build)
);

console.log("\nand only after the name is typed");
check("the card knows which sections a design removes", /const removalsIn = \(plans/.test(panel));
// A tap is not a confirmation. The typed name has to match before the
// build call is made at all — checked in the handler as well as on the
// button, because a disabled button is a suggestion.
check(
  "building refuses until the typed name matches",
  /const removing = removalsIn\(r\.plans\);\s*\n\s*if \(removing\.length && confirmText\.trim\(\) !== removing\.join\(", "\)\) return;/.test(panel)
);
check(
  "and the button is not the only thing stopping it",
  /disabled=\{busy \|\| confirmText\.trim\(\) !== removalsIn\(r\.plans\)\.join\(", "\)\}/.test(panel)
);

console.log(fails.length === 0 ? "\na removal is proposed, never built by machine" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
