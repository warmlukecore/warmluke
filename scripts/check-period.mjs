// A choice of dates over a section (0161), and a plan that replaces a
// section's view saying so.
//
// Asked for 15 / 30 / 60 days over Orders, Luke wrote a screen in place
// of its table: nothing here could narrow a section to days, and the
// card said only "a screen written for it". Now a section can carry a
// period, read by one rule everywhere (lib/period.ts: a bare day by its
// day, a timestamp by its instant in the shop's zone), the validator
// keeps a stat from counting days of its own under it, and the card
// says what a new view takes the place of.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-period.mjs

import {
  inPeriod,
  keptPick,
  openingPick,
  openingPickFor,
  periodRange,
  pickLabel,
  pickMemory,
  weekStartOf,
} from "../src/lib/period.ts";
import { validateFeatures } from "../src/lib/ai.ts";
import { describeFeaturesFull, describeForOwner } from "../src/lib/describe.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the last N days are the shop's days");
// 00:30 on 3 October in Mumbai, still 2 October in UTC.
const now = new Date("2026-10-02T19:00:00Z");
const r = periodRange("placed_at", { days: 15 }, "Asia/Kolkata", now);
check("the last 15 days run to today, in the shop's zone", r?.toDay === "2026-10-03" && r?.fromDay === "2026-09-19");
check("from the zone's own midnight", r?.from === "2026-09-18T18:30:00.000Z" && r?.to === "2026-10-03T18:30:00.000Z");
check("an order at 00:01 on the first day is in", inPeriod("2026-09-18T18:31:00Z", r));
check("one at 23:59 the day before is not, though UTC calls both the 18th", !inPeriod("2026-09-18T18:29:00Z", r));
check("one placed a moment ago is in", inPeriod("2026-10-02T19:00:00+00:00", r));
check("a bare day is compared as a day", inPeriod("2026-09-19", r) && !inPeriod("2026-09-18", r));
check("empty, or not a date, is outside", !inPeriod("", r) && !inPeriod(null, r) && !inPeriod("soon", r));
const today = periodRange("placed_at", { days: 1 }, "Asia/Kolkata", now);
check("one day is today alone", today?.fromDay === "2026-10-03" && today?.toDay === "2026-10-03");

console.log("\ntheir own dates");
const own = periodRange("placed_at", { from: "2026-09-30", to: "2026-09-01" }, "UTC", now);
check(
  "typed the wrong way round, still the days between",
  own?.fromDay === "2026-09-01" && own?.toDay === "2026-09-30"
);
check("and the last day is whole", inPeriod("2026-09-30T23:59:59Z", own) && !inPeriod("2026-10-01T00:00:00Z", own));
check(
  "a half-typed date picks nothing",
  periodRange("placed_at", { from: "2026-09", to: "2026-09-30" }, "UTC", now) === null
);
check("all is no window", periodRange("placed_at", null, "UTC", now) === null);
check(
  "said in words",
  pickLabel({ days: 15 }) === "Last 15 days" && pickLabel(null) === "All" && pickLabel({ days: 1 }) === "Today"
);

console.log("\nwhat a section opens on, and what this device kept");
const spec = { field: "placed_at", presets: [15, 30, 60], default: 15 };
check("its default", JSON.stringify(openingPick(spec)) === '{"days":15}');
check("a default that is not a preset opens on all", openingPick({ ...spec, default: 45 }) === null);
check("kept: all", keptPick('"all"', spec) === null);
check("kept: a preset", keptPick('{"days":30}', spec)?.days === 30);
check("kept: a preset since taken away is not kept", keptPick('{"days":7}', spec) === undefined);
check("kept: their own dates", keptPick('{"from":"2026-09-01","to":"2026-09-30"}', spec)?.from === "2026-09-01");
check("kept: anything else is not", keptPick("{oops", spec) === undefined && keptPick(null, spec) === undefined);

console.log("\nthe validator");
const columns = [
  { field: "order_number", label: "Order", type: "text" },
  { field: "placed_at", label: "Placed", type: "date" },
  { field: "total", label: "Total", type: "currency" },
  { field: "status", label: "Status", type: "badge" },
];
const errorsOf = (features, periodField) => {
  const errors = [];
  validateFeatures(structuredClone(features), columns, errors, undefined, undefined, periodField);
  return errors;
};
const fifteen = { op: "<=", args: [{ op: "days_since", args: [{ field: "placed_at" }] }, { const: 15 }] };
const paid = { op: "=", args: [{ field: "status" }, { const: "PAID" }] };
check("a period over a date column is taken", errorsOf({ period: spec }).length === 0);
check(
  "over a column that is not a date, refused",
  errorsOf({ period: { field: "total" } })
    .join(" ")
    .includes("needs a date column")
);
check(
  "over no column at all, refused",
  errorsOf({ period: { field: "created" } })
    .join(" ")
    .includes("not a column here")
);
check(
  "presets are a few whole days",
  errorsOf({ period: { field: "placed_at", presets: [0, 15] } }).length === 1 &&
    errorsOf({ period: { field: "placed_at", presets: [15, 15] } }).length === 1 &&
    errorsOf({ period: { field: "placed_at", presets: [1, 2, 3, 4, 5, 6, 7] } }).length === 1
);
check("its default is one of them", errorsOf({ period: { field: "placed_at", default: 45 } }).length === 1);
check(
  "with no presets, the default ones",
  errorsOf({ period: { field: "placed_at", default: 30 } }).length === 0 &&
    errorsOf({ period: { field: "placed_at", default: 15 } }).length === 1
);
const counts = (where) => [{ label: "Revenue (15d)", op: "sum", value: { field: "total" }, where }];
check(
  "a stat that counts its own days under the period is refused",
  errorsOf({ period: spec, stats: counts({ op: "and", args: [paid, fifteen] }) })
    .join(" ")
    .includes("the period above the section already picks the days")
);
check(
  "and under a period the section has already",
  errorsOf({ stats: counts(fifteen) }, "placed_at")
    .join(" ")
    .includes("already picks the days")
);
check(
  "not when this change takes the period away",
  errorsOf({ period: null, stats: counts(fifteen) }, "placed_at").length === 0
);
check(
  "days of another field are its own business",
  errorsOf({
    period: spec,
    stats: counts({ op: "<=", args: [{ op: "days_since", args: [{ field: "paid_on" }] }, { const: 3 }] }),
  }).filter((e) => e.includes("already picks")).length === 0
);
check("a stat with no days in it is fine", errorsOf({ period: spec, stats: counts(paid) }).length === 0);

console.log("\nthe card");
const modules = [{ id: "m1", name: "orders", nav_label: "Orders", source_table: "orders" }];
check(
  "says what the period offers",
  describeFeaturesFull({ period: spec }, modules).includes(
    "Choose the dates by placed_at: the last 15, 30 or 60 days, their own dates, or all (opens on the last 15 days)"
  )
);
check(
  "by its label when it has one",
  describeFeaturesFull({ period: { field: "placed_at", label: "Placed" } }, modules)[0].startsWith(
    "Choose the dates by Placed: the last 7, 30 or 90 days"
  )
);
const screen = { type: "custom", title: "Orders dashboard", html: "<div></div>" };
const board = { type: "board", groupBy: "status", cardTitle: "order_number" };
const plan = (view) => ({ changeType: "FEATURE_UPDATE", targetModuleId: "m1", features: { view } });
// The section's features today: undefined when not in view, null for none (its table).
const warn = (view, current) =>
  describeForOwner(
    plan(view),
    modules,
    undefined,
    null,
    current === undefined ? undefined : current && { view: current }
  ).warnings ?? [];
check(
  "a written screen over the table says the table goes, and how it comes back",
  warn(screen, null)[0] ===
    "Orders will show the screen “Orders dashboard” written for it in place of its table. Its rows stay; Put it back, once it is built, brings the table back."
);
check(
  "over a section not in view, it still says so",
  warn(screen, undefined)[0]?.includes("in place of its current view")
);
check(
  "a board over the table says so",
  warn(board, null)[0]?.startsWith("Orders will show a board in place of its table")
);
check("the same screen rewritten says nothing", warn(screen, screen).length === 0);
check(
  "the table again over a screen says the screen goes",
  warn(null, screen)[0]?.startsWith("Orders will show a table in place of its screen “Orders dashboard”")
);
check(
  "a change that leaves the view alone says nothing",
  (
    describeForOwner(
      { changeType: "FEATURE_UPDATE", targetModuleId: "m1", features: { period: spec } },
      modules,
      undefined,
      null,
      null
    ).warnings ?? []
  ).length === 0
);
check("a board over a section not in view says nothing it cannot know", warn(board, undefined).length === 0);

console.log("\nnamed spans, worked out from today each time (3 Oct 2026, a Saturday, in Mumbai)");
{
  const span = (named, weekStart = 1) => {
    const r = periodRange("placed_at", { named }, "Asia/Kolkata", now, weekStart);
    return r && `${r.fromDay}..${r.toDay}`;
  };
  check("yesterday", span("yesterday") === "2026-10-02..2026-10-02");
  check("this week, from Monday", span("this_week") === "2026-09-28..2026-10-03");
  check("this week, where weeks start on Sunday", span("this_week", 0) === "2026-09-27..2026-10-03");
  check("last week", span("last_week") === "2026-09-21..2026-09-27");
  check("this month", span("this_month") === "2026-10-01..2026-10-03");
  check("last month", span("last_month") === "2026-09-01..2026-09-30");
  check("this year", span("this_year") === "2026-01-01..2026-10-03");
  check("a name it does not know is no window", periodRange("placed_at", { named: "fortnight" }, "UTC", now) === null);
  check("said in words", pickLabel({ named: "last_month" }) === "Last month");
  check("kept, by name, so it rolls over", keptPick('{"named":"this_month"}', spec)?.named === "this_month");
  check("and Today is kept whatever the presets", keptPick('{"days":1}', spec)?.days === 1);
  check(
    "an Indian week starts on Sunday, a British one on Monday",
    weekStartOf("en-IN") === 0 && weekStartOf("en-GB") === 1
  );
}

console.log("\nthe dates a section opens on, worked out once (6 Oct)");
{
  // The page reads its rows before the bar above them is drawn: both ask
  // openingPickFor, so the first read is inside the dates shown, not whole.
  const spec = { field: "placed_at", presets: [7, 30, 90], default: 30 };
  const kept = {};
  globalThis.localStorage = { getItem: (k) => kept[k] ?? null };
  const key = pickMemory("m1");
  check("nothing kept: the section's default", openingPickFor(spec, key)?.days === 30);
  kept[key] = JSON.stringify({ from: "2026-09-01", to: "2026-09-30" });
  const own = openingPickFor(spec, key);
  check("their own dates, kept on this device", own?.from === "2026-09-01" && own?.to === "2026-09-30");
  kept[key] = '"all"';
  check("every row, when that is what they last chose", openingPickFor(spec, key) === null);
  kept[key] = '{"days":14}';
  check("a preset since taken away: the default", openingPickFor(spec, key)?.days === 30);
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("refused");
    },
  };
  check("storage refused: the default", openingPickFor(spec, key)?.days === 30);
  check("no key (a preview): the default", openingPickFor(spec, "")?.days === 30);
  delete globalThis.localStorage;
}

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\na section's dates are one rule, and a replaced view says so"
);
process.exit(fails.length ? 1 : 0);
