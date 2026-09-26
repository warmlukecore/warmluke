// "5 min ago", said the same way on every screen that says it.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-when.mjs

import { ago, dayGroup } from "../src/lib/when.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const now = Date.parse("2026-09-23T12:00:00Z");
const before = (ms) => new Date(now - ms).toISOString();
const MIN = 60e3;

check("a moment ago is just now", ago(before(30e3), now) === "just now");
check("minutes are minutes", ago(before(5 * MIN), now) === "5 min ago");
check("hours are hours", ago(before(3 * 60 * MIN), now) === "3 h ago");
check("a day ago is yesterday", ago(before(24 * 60 * MIN), now) === "yesterday");
check("days are days", ago(before(5 * 24 * 60 * MIN), now) === "5 days ago");
check("months are months", ago(before(65 * 24 * 60 * MIN), now) === "2 mo ago");
check("nothing yet says what the screen asks it to", ago(null, now, "not yet") === "not yet");
check("a date that is not a date is not a time", ago("soon", now) === "never");
check("a clock a little ahead is not the future", ago(new Date(now + 30e3).toISOString(), now) === "just now");

// Past conversations by the day, in the viewer's own calendar: made from
// local times so the check holds in every time zone it runs in.
const local = (d, h) => new Date(2026, 8, d, h).getTime();
const at = (d, h) => new Date(local(d, h)).toISOString();
const nine = local(23, 9);
check("earlier today is today", dayGroup(at(23, 1), nine) === "Today");
check("last night is yesterday, however few hours ago", dayGroup(at(22, 23), nine) === "Yesterday");
check("the day before that is the last week", dayGroup(at(21, 12), nine) === "Last 7 days");
check("a week back is older", dayGroup(at(16, 12), nine) === "Older");
check("a clock a little ahead is still today", dayGroup(new Date(nine + 30e3).toISOString(), nine) === "Today");

console.log(fails.length === 0 ? "\ntime is said one way, and days are the calendar's" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
