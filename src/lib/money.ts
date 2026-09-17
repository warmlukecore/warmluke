// ─────────────────────────────────────────────────────────────
// Turning numbers into money, dates and percentages.
//
// Kept apart from the React provider next door so it can be run
// without a renderer: what a converted amount comes out as is the sort
// of thing that has to be checked, and a check should not need a DOM
// to ask.
//
// Callers: src/lib/format.tsx, scripts/check-fx.mjs.
// ─────────────────────────────────────────────────────────────

"use client";

// ─────────────────────────────────────────────────────────────
// Number, money and date formatting for the project's own locale.
// It used to be en-US/USD in the renderer, which quietly told an
// Indian shop their ₹1,250 was $1,250. Locale lives on the project
// row; India is the default, not the only choice.
// ─────────────────────────────────────────────────────────────


export interface Formatting {
  locale: string;
  currency: string;
  number: (n: number) => string;
  money: (n: number) => string;
  date: (v: string) => string;
  time: (v: string) => string;
  percent: (n: number) => string;
}

export const DEFAULT_LOCALE = "en-IN";
export const DEFAULT_CURRENCY = "INR";

/**
 * Turns an amount in one currency into another before it is formatted.
 *
 * Passed in rather than looked up, so the one place that renders money
 * is also the one place that converts it — a converter applied by each
 * caller is a converter half of them forget.
 */
export type Converter = { rate: number; from: string };

export function makeFormatting(
  locale: string,
  currency: string,
  convert?: Converter | null
): Formatting {
  // Intl throws on a malformed tag; a bad stored value must not blank
  // out every number on the page.
  const safeLocale = (() => {
    try {
      new Intl.NumberFormat(locale);
      return locale;
    } catch {
      return DEFAULT_LOCALE;
    }
  })();

  const nf = new Intl.NumberFormat(safeLocale);
  let cf: Intl.NumberFormat;
  try {
    cf = new Intl.NumberFormat(safeLocale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    cf = new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: "currency",
      currency: DEFAULT_CURRENCY,
      maximumFractionDigits: 2,
    });
  }

  return {
    locale: safeLocale,
    currency,
    number: (n) => nf.format(n),
    // Converted first, formatted second. Rounding the amount and then
    // converting it would round twice and drift.
    money: (n) => cf.format(convert ? n * convert.rate : n),
    date: (v) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return v;
      return d.toLocaleDateString(safeLocale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    },
    time: (v) => {
      // Stored as HH:MM; render in the locale's clock convention.
      const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
      if (!m) return v;
      const d = new Date();
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return d.toLocaleTimeString(safeLocale, { hour: "numeric", minute: "2-digit" });
    },
    percent: (n) => `${nf.format(n)}%`,
  };
}

