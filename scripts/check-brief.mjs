// The day's brief (lib/brief): ranked by what matters, cut to a few lines.
//
// Pure: critical alerts first, then what waits for a yes, then builds a
// check failed on, then the rest noticed, what was built, what is
// watched; never more than BRIEF_MAX lines; a quiet day says nothing.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-brief.mjs
import { BRIEF_MAX, briefOf } from "../src/lib/brief.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const none = { waiting: 0, alerts: [], builds: [], watching: 0 };

console.log("\nthe brief");
check("a quiet day says nothing", briefOf(none).length === 0);

const full = briefOf({
  waiting: 2,
  alerts: [
    { severity: "attention", title: "3 products are running low" },
    { severity: "critical", title: "Returns doubled this week" },
    { severity: "attention", title: "Shipping is slower" },
  ],
  builds: [
    { what: "Reorder list", ok: false },
    { what: "Returns board", ok: true },
  ],
  watching: 4,
});
check("a critical alert comes first", full[0].tone === "critical" && full[0].text === "Returns doubled this week");
check("then what waits for a yes", full[1].text === "2 things wait for your yes");
check("then a build whose check failed, by name", full[2].text === "Reorder list: built, and a check did not pass");
check("the rest noticed, counted", full[3].text === "2 more things Luke noticed");
check("what was built", full[4].text === "Luke finished 1 build today, each tested on your data");
check(`never more than ${BRIEF_MAX} lines: the watched count is the one cut`, full.length === BRIEF_MAX);

console.log("\neach line in its own words");
check("one waits", briefOf({ ...none, waiting: 1 })[0].text === "1 thing waits for your yes");
check(
  "one noticed is said by its title",
  briefOf({ ...none, alerts: [{ severity: "attention", title: "Low stock" }] })[0].text === "Low stock"
);
check(
  "a build not tested does not claim it was",
  briefOf({
    ...none,
    builds: [
      { what: "A", ok: true },
      { what: "B", ok: null },
    ],
  })[0].text === "Luke finished 2 builds today"
);
check(
  "a failed build is not counted as finished",
  !briefOf({ ...none, builds: [{ what: "A", ok: false }] }).some((l) => l.tone === "success")
);
check("what is watched", briefOf({ ...none, watching: 1 })[0].text === "Watching 1 thing for you");
const crit = briefOf({
  ...none,
  alerts: ["a", "b", "c"].map((t) => ({ severity: "critical", title: t })),
});
check(
  "two critical by name, a third with the rest",
  crit.length === 3 && crit[2].text === "c" && crit[2].tone === "attention"
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nthe brief says the day in a few lines, worst first");
process.exit(fails.length ? 1 : 0);
