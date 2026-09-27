// The critic on designs it has seen before, and their weakened copies.
//
// Four cases, kept as fixtures: two designs as they were drawn (nothing
// missing, nothing sent back) and the same two with the point of the
// ask taken out — the scan bar and the packed fields, the amount
// fields. A critic worth its call says "fits" to the first pair and
// sends the packing copy back for the scan; the COD copy is a known
// blind spot (its stats still name the fields) and is reported, not
// held. Model tier: real calls, by hand, when the critic's prompt or
// model changes.
//
//   ANTHROPIC_CRITIC_MODEL=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-critic-eval.mjs
//   (a real key in the environment; MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { readFileSync } from "node:fs";
import { criticModel, critique, planModel } from "../src/lib/ai.ts";

const model = criticModel() ?? planModel();
if (!model) {
  console.log("ANTHROPIC_CRITIC_MODEL (or ANTHROPIC_PLAN_MODEL) is not set; nothing checked");
  process.exit(0);
}
const cases = JSON.parse(readFileSync(new URL("./fixtures/critic-cases.json", import.meta.url), "utf8"));

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log(`the critic on ${model}`);
for (const c of cases) {
  const t0 = Date.now();
  const v = await critique({ ownerWords: c.ask, understood: c.understood, builtDescription: c.built, model });
  console.log(`\n${c.name}  (${Date.now() - t0}ms)`);
  console.log(`     → ${JSON.stringify(v)}`);
  if (!v) {
    check("a verdict came back", false);
    continue;
  }
  if (c.expect.unmet === "none") {
    check("nothing missing in a design as drawn", v.unmet.length === 0);
    check("and nothing sent back", v.redo === null);
  } else if (c.expect.unmet === "scan") {
    check(
      "the scan the owner asked for is missing",
      v.unmet.some((u) => /scan/i.test(u))
    );
    check("and the design goes back for it", typeof v.redo === "string" && v.redo.length > 0);
  } else {
    // Known blind spot: said, not held.
    console.log(
      `  ${v.unmet.length ? "ok  " : "note"}  the amounts taken out ${v.unmet.length ? "were" : "were not"} caught`
    );
  }
}

console.log(
  fails.length === 0 ? "\nthe critic fits what fits and sends back what misses the point" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
