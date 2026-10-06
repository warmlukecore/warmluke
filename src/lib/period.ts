// A section's choice of dates (features.period, 0161): what was picked,
// as days and instants, and whether a row falls inside it.
//
// One rule for every place that narrows by it: the rows the page reads
// (AppShell), what it filters in the browser (GenericRenderer), and the
// stat cards, counted on the server by abo_in_period with the same two
// cases. A bare day (YYYY-MM-DD, a date column of their own) is compared
// as a day; a timestamp (a store's placed_at) by its instant, against the
// zone's own midnights, so an order at 00:30 in Mumbai is that day's.
//
// Callers: src/components/GenericRenderer.tsx, src/components/AppShell.tsx,
// src/lib/slice.ts (todayIn, shiftDay), scripts/check-period.mjs.

import { dayRangeInZone } from "@/lib/store-read";
import type { FeatureSchema } from "@/lib/types";

export type PeriodSpec = NonNullable<FeatureSchema["period"]>;

/**
 * A calendar span by its name, worked out from today each time it is read:
 * "This month" kept as two dates would still show October in November.
 */
export const NAMED = {
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  this_year: "This year",
} as const;
export type Named = keyof typeof NAMED;

/** The last N days, a named span, their own two dates, or every row (null). */
export type PeriodPick = { days: number } | { named: Named } | { from: string; to: string } | null;

/** A pick worked out: inclusive days in the zone, and the instants they start and stop at. */
export type PeriodRange = { field: string; fromDay: string; toDay: string; from: string; to: string };

export const DEFAULT_PRESETS = [7, 30, 90];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in a zone, YYYY-MM-DD. */
export const todayIn = (timeZone: string, now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** A YYYY-MM-DD day moved by whole days. */
export const shiftDay = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const presetsOf = (spec: PeriodSpec) => (spec.presets?.length ? spec.presets : DEFAULT_PRESETS);

/** The first day of the week a day is in; weekStart 0 is Sunday, as Date counts. */
export const weekOf = (day: string, weekStart = 1) =>
  shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7));

/** The day a week starts in a locale (0 Sunday … 6 Saturday), Monday where the browser cannot say. */
export function weekStartOf(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    return typeof first === "number" ? first % 7 : 1;
  } catch {
    return 1;
  }
}

/** A named span's two days, from today. */
function namedDays(name: Named, today: string, weekStart: number): [string, string] {
  const month = `${today.slice(0, 8)}01`;
  switch (name) {
    case "yesterday":
      return [shiftDay(today, -1), shiftDay(today, -1)];
    case "this_week":
      return [weekOf(today, weekStart), today];
    case "last_week":
      return [shiftDay(weekOf(today, weekStart), -7), shiftDay(weekOf(today, weekStart), -1)];
    case "this_month":
      return [month, today];
    case "last_month":
      return [`${shiftDay(month, -1).slice(0, 8)}01`, shiftDay(month, -1)];
    case "this_year":
      return [`${today.slice(0, 4)}-01-01`, today];
  }
}

/** What the section opens on: its default, when that is one of its presets. */
export const openingPick = (spec: PeriodSpec): PeriodPick =>
  typeof spec.default === "number" && presetsOf(spec).includes(spec.default) ? { days: spec.default } : null;

export function periodRange(
  field: string,
  pick: PeriodPick,
  timeZone: string,
  now: Date = new Date(),
  weekStart = 1
): PeriodRange | null {
  if (!pick) return null;
  let fromDay: string, toDay: string;
  if ("days" in pick) {
    toDay = todayIn(timeZone, now);
    fromDay = shiftDay(toDay, -(Math.max(1, Math.floor(pick.days)) - 1));
  } else if ("named" in pick) {
    if (!(pick.named in NAMED)) return null;
    [fromDay, toDay] = namedDays(pick.named, todayIn(timeZone, now), weekStart);
  } else {
    if (!DAY.test(pick.from) || !DAY.test(pick.to)) return null;
    // Typed the wrong way round is still the days between them.
    [fromDay, toDay] = pick.from <= pick.to ? [pick.from, pick.to] : [pick.to, pick.from];
  }
  return {
    field,
    fromDay,
    toDay,
    from: dayRangeInZone(fromDay, timeZone).from,
    to: dayRangeInZone(toDay, timeZone).to,
  };
}

/** Whether a value falls in the window. Empty, or not a date, is outside it. */
export function inPeriod(value: unknown, r: PeriodRange): boolean {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return false;
  if (DAY.test(s)) return s >= r.fromDay && s <= r.toDay;
  const t = Date.parse(s);
  return !Number.isNaN(t) && t >= Date.parse(r.from) && t < Date.parse(r.to);
}

const shortDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** The pick in words, for the chip and for a screen reader: "Last 15 days", "3 Sep – 2 Oct". */
export function pickLabel(pick: PeriodPick): string {
  if (!pick) return "All";
  if ("days" in pick) return pick.days === 1 ? "Today" : `Last ${pick.days} days`;
  if ("named" in pick) return NAMED[pick.named] ?? "All";
  const day = shortDay;
  return pick.from === pick.to ? day(pick.from) : `${day(pick.from)} – ${day(pick.to)}`;
}

/** Where this device keeps a section's pick. */
export const pickMemory = (moduleId: string) => `abo_period:${moduleId}`;

/**
 * The pick a section opens on: what this device last chose for it, while
 * it still fits, else the section's default. The page works it out before
 * its first read and the bar above the section draws the same, so the
 * rows are read once, inside the dates shown: they were read whole, then
 * in the default, then in the pick kept, each landing a moment apart.
 */
export function openingPickFor(spec: PeriodSpec, memory: string): PeriodPick {
  let raw: string | null = null;
  try {
    raw = memory ? localStorage.getItem(memory) : null;
  } catch {
    // Storage refused (a private window): the section's default it is.
  }
  const kept = keptPick(raw, spec);
  return kept !== undefined ? kept : openingPick(spec);
}

/**
 * What this device last picked for a section, kept as JSON ("all" for
 * every row), when it still fits the section: a preset since taken away
 * opens on the section's default instead. Undefined when nothing fits.
 */
export function keptPick(raw: string | null, spec: PeriodSpec): PeriodPick | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (v === "all") return null;
    if (v && typeof v.days === "number" && (v.days === 1 || presetsOf(spec).includes(v.days))) return { days: v.days };
    if (v && typeof v.named === "string" && v.named in NAMED) return { named: v.named as Named };
    if (v && DAY.test(String(v.from)) && DAY.test(String(v.to))) return { from: v.from, to: v.to };
  } catch {
    // Not ours, or from an older shape: the section's own default.
  }
  return undefined;
}
