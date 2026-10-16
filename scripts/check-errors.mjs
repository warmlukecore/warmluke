// The error contract, and the two things in it that can be wrong
// without anyone noticing: which rows count as "nearly the same code",
// and what Luke is told when a design did not fit.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-errors.mjs

import { asError, engineError, fixPrompt, nearest, retryFix } from "../src/lib/errors.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const rows = [
  ["12354", "Clear Phone Case · S"],
  ["012345", "Boat Airdopes · Blue"],
  ["98765", "Ski Wax"],
  ["12346", "Snowboard · Dawn"],
  ["CASE-L", "Clear Phone Case · L"],
].map(([value, item]) => ({ value, item }));
const near = (v) => nearest(v, rows).map((n) => n.value);

console.log("a code that matched nothing, and the rows a keystroke away");
check("a swapped pair is one edit away", near("12345").includes("12354"));
check("a dropped leading zero is one edit away", near("12345").includes("012345"));
check("one wrong digit is one edit away", near("12345").includes("12346"));
check("a different code altogether is not offered", !near("12345").includes("98765"));
check("closest first, at most three", near("12345").length === 3);
check("nothing close means nothing offered", near("99999").length === 0);
check("case and spacing are not differences", near("case-l ").length === 0 && near("CASE-1").includes("CASE-L"));
check("an exact match is not a near match", !near("12354").includes("12354"));
check("an empty scan offers nothing", near("   ").length === 0);

console.log("\nwhat Luke is told");
const p = fixPrompt({
  what: "a packing section",
  tried: { changeType: "FEATURE_UPDATE" },
  errors: ['Filter field "x" doesn\'t exist'],
});
check("it names what was asked for", /a packing section/.test(p));
check("and what was tried", /FEATURE_UPDATE/.test(p));
check("and why it did not fit", /doesn't exist/.test(p));
check("and asks for the same job, corrected", /same job/.test(p) && /only what has to change/i.test(p));
const long = fixPrompt({ what: "x", tried: { big: "y".repeat(10000) }, errors: [] });
check("a huge plan is cut, not sent whole", long.length < 5000);

console.log("\nthe shape");
const e = engineError("It did not fit.", ["a", "b", "c", "d", "e", "f", "g"], "prompt", "because");
check("an engine error offers Luke first", e.fix?.[0]?.action.type === "ask_luke" && e.fix[0].label.includes("Luke"));
check("and keeps at most six lines of detail", e.details?.length === 6);
check(
  "a thrown Error becomes a system error",
  asError(new Error("boom")).kind === "system" && asError(new Error("boom")).what === "boom"
);
check("a string becomes a system error", asError("nope").what === "nope");
check("an AppError passes through untouched", asError(e) === e);
check("nothing at all gets the fallback", asError(undefined, "fallback").what === "fallback");

console.log("\na turn Luke could not finish is tried again by one click, never retyped");
const again = retryFix("make a returns tool", null, ['plans[0]: no field "order"', "rule: unknown op"]);
check("a Try again way out", again?.label === "Try again" && again.action.type === "ask_again");
check(
  "the same words, with what failed, for another road",
  again.action.prompt.startsWith("make a returns tool\n\n(Asked again. The last try failed its own checks: plans[0]") &&
    again.action.prompt.includes("Take another way")
);
check("nothing failed, the words alone", retryFix("make a returns tool").action.prompt === "make a returns tool");
check(
  "tried again twice, the note is not doubled",
  retryFix(again.action.prompt, null, ["x"]).action.prompt.match(/Asked again/g).length === 1
);
check("a busy model: try again", retryFix("hi", "busy") !== null);
check(
  "never where a second try cannot help: the account, the key, the setup",
  ["billing", "auth", "unset"].every((k) => retryFix("hi", k) === null)
);
check("nothing asked, nothing to send again", retryFix("   ") === null);

console.log(fails.length === 0 ? "\nan error knows its way out" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
