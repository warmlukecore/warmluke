// The router is measured on forty real questions, and may not get worse.
//
// scripts/fixtures/route-questions.json holds forty questions merchants
// really asked, half in Hinglish, with what the router should make of
// each: the list, the span,
// the kind of answer, the word a lookup looks for, or that it must not be
// routed at all. This asks the router every one and scores each part, and
// fails when any part scores below the baseline written in the file.
//
// Played back from the tapes by default (model-tape.ts): free, the same
// every run, and it catches our own code getting worse at reading what
// the model said. Recorded against the real router it measures the model
// itself, and says how long it took against the three seconds a chat
// turn gives it:
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-route-eval.mjs
//   MODEL_TAPE=record … the same            # the real router, cents
//   MODEL_TAPE=record EVAL_REBASELINE=1 …    # and write its scores as the baseline
//
// The baseline only moves when asked: a worse model re-recorded must not
// quietly lower the bar it is held to.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { routeQuestion } from "../src/lib/route.ts";

process.env.MODEL_TAPE ??= "replay";
const recording = process.env.MODEL_TAPE === "record";
if (recording && !process.env.TYPESAFE_API_KEY) {
  const file = new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url);
  const found = existsSync(file) ? readFileSync(file, "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m) : null;
  if (found) process.env.TYPESAFE_API_KEY = found[1].trim();
}

const where = new URL("./fixtures/route-questions.json", import.meta.url);
const set = JSON.parse(readFileSync(where, "utf8"));
// What a chat turn allows the router before going on without it.
const TURN_MS = 3000;
const PARTS = ["gated", "list", "window", "month", "kind", "needle"];
const score = Object.fromEntries(PARTS.map((p) => [p, { ok: 0, of: 0 }]));
const mark = (part, right) => {
  score[part].of++;
  if (right) score[part].ok++;
  return right;
};
const misses = [];
const took = [];

for (const item of set.questions) {
  // Generous: this measures what it answers, not how fast; the speed is said apart.
  const route = await routeQuestion(item.q, 20_000);
  if (route) took.push(route.ms);
  if (item.route === null) {
    if (!mark("gated", route === null))
      misses.push(`"${item.q}" should not be routed (${item.because}); read as ${route.list}/${route.kind}`);
    continue;
  }
  const wrong = [];
  if (!mark("list", route?.list === item.list)) wrong.push(`list ${route?.list ?? "none"}≠${item.list}`);
  if (!mark("window", route?.window === item.window)) wrong.push(`window ${route?.window ?? "none"}≠${item.window}`);
  if (item.month !== undefined && !mark("month", route?.month === item.month))
    wrong.push(`month ${route?.month ?? "none"}≠${item.month}`);
  if (!mark("kind", route?.kind === item.kind)) wrong.push(`kind ${route?.kind ?? "none"}≠${item.kind}`);
  if (
    item.needle !== undefined &&
    !mark("needle", !!route?.needles.some((n) => n.toLowerCase() === item.needle.toLowerCase()))
  )
    wrong.push(`needle "${item.needle}" not among the words looked for`);
  if (wrong.length) misses.push(`"${item.q}": ${route ? wrong.join(", ") : "not routed at all"}`);
}

const pct = (s) => (s.of ? Math.round((100 * s.ok) / s.of) : 100);
console.log(`the router on ${set.questions.length} real questions, ${recording ? "recorded now" : "played back"}`);
const fails = [];
for (const p of PARTS) {
  const s = score[p];
  const floor = set.baseline?.[p];
  const below = floor !== undefined && s.ok < floor;
  if (below) fails.push(p);
  console.log(
    `  ${below ? "FAIL" : "ok  "}  ${p.padEnd(7)} ${String(s.ok).padStart(2)}/${s.of} (${pct(s)}%)${floor !== undefined ? `, at least ${floor}` : ""}`
  );
}
if (misses.length) {
  console.log("\nwhat it got wrong");
  for (const m of misses) console.log(`  · ${m}`);
}
if (recording && took.length) {
  const sorted = [...took].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const slow = took.filter((ms) => ms > TURN_MS).length;
  console.log(
    `\nhow long: median ${at(0.5)} ms, 95th ${at(0.95)} ms; ${slow} of ${took.length} took longer than a chat turn waits (${TURN_MS} ms)`
  );
}

if (!set.baseline) {
  if (recording && process.env.EVAL_REBASELINE) {
    set.baseline = Object.fromEntries(PARTS.map((p) => [p, score[p].ok]));
    writeFileSync(where, `${JSON.stringify(set, null, 2)}\n`);
    console.log("\nbaseline written");
  } else {
    console.log("\nno baseline yet: record with MODEL_TAPE=record EVAL_REBASELINE=1");
    process.exit(1);
  }
} else if (recording && process.env.EVAL_REBASELINE && fails.length === 0) {
  set.baseline = Object.fromEntries(PARTS.map((p) => [p, score[p].ok]));
  writeFileSync(where, `${JSON.stringify(set, null, 2)}\n`);
  console.log("\nbaseline raised to what it scored now");
}

console.log(
  fails.length === 0
    ? "\nthe router reads questions at least as well as it did"
    : `\n${fails.length} FAILED: ${fails.join(", ")} scored below the baseline`
);
process.exit(fails.length === 0 ? 0 : 1);
