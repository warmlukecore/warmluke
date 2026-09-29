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

console.log(fails.length === 0 ? "\na schedule says when, on the store's clock" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
