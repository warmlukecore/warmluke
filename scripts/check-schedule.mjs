// A schedule's timing: what a rule may say and how it reads to the owner (0137).
//
// "Roz subah" ran whenever the rule was made: a schedule had an interval
// and nothing else. It may now name the time on the store's clock, the
// days of the week, the day of the month; the database's clocks decide
// when that is (check-code-jobs-live). Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-schedule.mjs

import { validateSchedule } from "../src/lib/ai.ts";
import { scheduleWords } from "../src/lib/describe.ts";
import { parseResult } from "../src/lib/code-run.ts";
import { storeClock } from "../src/lib/code-rules.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const refused = (trigger) => {
  const errors = [];
  validateSchedule({ type: "schedule", ...trigger }, errors);
  return errors;
};

console.log("\nwhat a schedule may say");
for (const [name, t] of [
  ["every morning at seven", { every: "daily", at: "07:00" }],
  ["every Monday at nine", { every: "weekly", on: ["mon"], at: "09:00" }],
  [
    "Monday to Saturday at half past nine",
    { every: "daily", on: ["mon", "tue", "wed", "thu", "fri", "sat"], at: "09:30" },
  ],
  ["the 1st of every month at eight", { every: "monthly", date: 1, at: "08:00" }],
  ["every month, on the 1st by itself", { every: "monthly" }],
  ["an interval, as before", { every: "daily" }],
])
  check(name, refused(t).length === 0);

console.log("\nand what it may not");
for (const [name, t] of [
  ["an hourly one at a time", { every: "hourly", at: "07:00" }],
  ["a time not written HH:MM", { every: "daily", at: "7am" }],
  ["a time past the day", { every: "daily", at: "24:00" }],
  ["a week at a time, with no day", { every: "weekly", at: "09:00" }],
  ["a day that is not one", { every: "weekly", on: ["funday"] }],
  ["days on a monthly one", { every: "monthly", on: ["mon"] }],
  ["a date past 31", { every: "monthly", date: 32 }],
  ["a date on a daily one", { every: "daily", date: 5 }],
  ["yearly, which is not a schedule here", { every: "yearly" }],
])
  check(name, refused(t).length > 0);

console.log("\nhow it reads to the owner");
check("every day at 07:00", scheduleWords({ type: "schedule", every: "daily", at: "07:00" }) === "Every day at 07:00");
check(
  "the days named",
  scheduleWords({ type: "schedule", every: "daily", on: ["mon", "sat"], at: "09:30" }) ===
    "Every Monday and Saturday at 09:30"
);
check(
  "a week by its day",
  scheduleWords({ type: "schedule", every: "weekly", on: "mon", at: "09:00" }) === "Every Monday at 09:00"
);
check(
  "a month by its date",
  scheduleWords({ type: "schedule", every: "monthly", date: 22 }) === "Every month on the 22nd" &&
    scheduleWords({ type: "schedule", every: "monthly", at: "08:00" }) === "Every month on the 1st at 08:00"
);
check(
  "an interval alone keeps its words, which the critic's recordings hold",
  scheduleWords({ type: "schedule", every: "daily" }) === null
);

// A rule's code works on the store's clock and says when it runs next
// in it (0138): no timezone arithmetic in the code, no timing words in
// the platform.
console.log("\na rule's code keeps the store's clock");
const evening = new Date("2026-09-29T18:45:00Z");
check(
  "past 18:30 in UTC it is already tomorrow in Kolkata",
  JSON.stringify(storeClock("Asia/Kolkata", evening)) ===
    JSON.stringify({ today: "2026-09-30", now: "2026-09-30T00:15" })
);
check("a zone this runtime does not know reads as UTC", storeClock("Mars/Olympus", evening).now === "2026-09-29T18:45");
check(
  "what it hands back as next is kept",
  parseResult({ set: [], next: "2026-09-30T07:00" })?.next === "2026-09-30T07:00"
);
check(
  "and only a date and time: anything else is no next",
  parseResult({ next: "tomorrow 7am" })?.next === undefined && parseResult({ next: 7 })?.next === undefined
);

console.log(fails.length === 0 ? "\na schedule says when, on the store's clock" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
