// What the merchant is told to do, and whether it is still true.
//
// A design proposed from Claude used to end with "it is waiting in
// Warmluke" and nothing else: no link that opened on it, no words
// for the buttons, and on a phone no sign of it at all once they got
// there. Every sentence about it was written for the model, not for
// the person who has to finish it.
//
// The instructions are generated now, which moves the risk: they can
// be confidently wrong. Three ways, and all three are checked here.
//
//   the steps can describe work that is not waiting;
//   they can name a button by words that are no longer on it;
//   the link can go to the app instead of to the thing.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-what-to-do.mjs

import { readFileSync } from "node:fs";
import { stepsToFinish, WAITING_BUTTONS } from "../src/lib/describe.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const LINK = "https://warmluke.test/app/p1?waiting=r1";
const build = [{ changeType: "FEATURE_UPDATE", targetModuleId: "m1" }];
const removal = [
  { changeType: "MODULE_DELETE", targetModuleId: "m2", deleteConfirmName: "product-2" },
  { changeType: "FEATURE_UPDATE", targetModuleId: "m1" },
];

console.log("nothing settled is ever presented as work");
for (const status of ["built", "dismissed", "opened"]) {
  check(`${status} asks for nothing`, stepsToFinish({ status, plans: build }, LINK).length === 0);
}

console.log("\nand what is waiting says where to go first");
for (const status of ["pending", "building", "partly_built"]) {
  const steps = stepsToFinish({ status, plans: build }, LINK);
  check(`${status}: there are steps`, steps.length > 0);
  check(`${status}: the first one is the link`, steps[0].includes(LINK));
}

console.log("\nand an ordinary design is one button");
{
  const steps = stepsToFinish({ status: "pending", plans: build }, LINK);
  check("it names the build button", steps.some((s) => s.includes(WAITING_BUTTONS.build)));
  check("and says nothing about typing a name", !steps.some((s) => /Type exactly/.test(s)));
  check("two steps, no more", steps.length === 2);
}

console.log("\nand one that removes a section is the longer way round");
{
  const steps = stepsToFinish({ status: "pending", plans: removal }, LINK);
  check("it opens the removal", steps.some((s) => s.includes(WAITING_BUTTONS.openRemoval)));
  // The whole safeguard, quoted exactly: a merchant told to type
  // something else types something else, and nothing happens.
  check("it gives the exact word to type", steps.some((s) => s === "Type exactly: product-2"));
  check("and then the confirm", steps.some((s) => s.includes(WAITING_BUTTONS.confirmRemoval)));
  check("and never offers the plain build", !steps.some((s) => s.includes(`"${WAITING_BUTTONS.build}"`)));
  // Order matters: the input does not exist until the first is tapped.
  const at = (t) => steps.findIndex((s) => s.includes(t));
  check(
    "in the order they happen",
    at(WAITING_BUTTONS.openRemoval) < at("Type exactly") && at("Type exactly") < at(WAITING_BUTTONS.confirmRemoval)
  );
}

console.log("\nand a half-built one is not offered as finishable");
{
  const steps = stepsToFinish({ status: "partly_built", plans: build }, LINK);
  check("no button is named", !steps.some((s) => /Tap "/.test(s)));
  check("it says to ask again", steps.some((s) => /again/.test(s)));
}

console.log("\nand two sections going take two names");
{
  const two = stepsToFinish(
    {
      status: "pending",
      plans: [
        { changeType: "MODULE_DELETE", deleteConfirmName: "product-2" },
        { changeType: "MODULE_DELETE", deleteConfirmName: "old-stock" },
      ],
    },
    LINK
  );
  check("both are quoted", two.some((s) => s === "Type exactly: product-2, old-stock"));
}

// ── The words, and the door ─────────────────────────────────────
//
// Source checks, because what they protect is agreement between two
// files: an instruction naming a button is a copy of that button,
// and a copy is what goes stale.
console.log("\nand the buttons really say what the steps quote");
{
  const panel = read("src/components/ChatPanel.tsx");
  check("the panel imports the words rather than typing them", /WAITING_BUTTONS/.test(panel));
  for (const [name, word] of Object.entries(WAITING_BUTTONS)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asLiteral = new RegExp(`>\\s*${escaped}\\s*<`);
    check(`${name} is not also written out in JSX`, !asLiteral.test(panel));
  }
}

console.log("\nand every link goes to the thing, not to the front door");
{
  const mcp = read("src/app/api/mcp/route.ts");
  const panel = read("src/components/ChatPanel.tsx");
  check("the links are built in one place", /const openAt = \(/.test(mcp));
  // The literal this replaced. One left behind is a link that lands
  // on a closed bell, which is the bug this all exists for.
  check("and nothing builds one by hand any more", !/open: `\$\{[^`]*\}\/app\/\$\{/.test(mcp));
  check("the panel opens on what the link names", /get\("waiting"\)/.test(panel));
  check("and the drawer opens with it on a phone", /get\("waiting"\)/.test(read("src/components/AppShell.tsx")));
}

console.log("\nand the panel is where those steps land");
{
  const panel = read("src/components/ChatPanel.tsx");
  // The steps tell a merchant to open Warmluke and tap something. If
  // the panel does not read the table, that sentence is a lie the
  // moment it is said.
  check("it reads the changes waiting for the shop", /from\("store_actions"\)/.test(panel));
  check("and hears about new ones without a reload", /table: "store_actions"/.test(panel));
  check("the count covers them too", /shopChanges\.filter\(\(a\) => a\.status === "pending"\)/.test(panel));
  // Fails closed: an entry that wants a word typed has nowhere here
  // to type it, and running it anyway would skip the only reason it
  // asked for one.
  check(
    "and a change wanting a typed word gets no button",
    /spec\.confirm === "list"/.test(panel)
  );
}

console.log(fails.length === 0 ? "\nthe instructions match the app" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
