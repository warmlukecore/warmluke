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
  /** An imported row may carry its own source currency. */
  money: (n: number, currency?: string | null) => string;
  /**
   * The same amount in the project's currency, said as an estimate —
   * or null when there is nothing honest to say.
   *
   * Deliberately NOT what `money` returns. A shop's amounts are shown
   * in the currency the shop recorded them in, because that is the
   * number a merchant can look up in Shopify. One current rate applied
   * to an old order produces a figure that was never true on any day,
   * so it may sit underneath as a rough second opinion and must never
   * stand in for the first.
   *
   * Null when: no rate is known, the row is already in the project's
   * currency, or the rate on hand is for a different pair.
   */
  approx: (n: number, currency?: string | null) => string | null;
  date: (v: string) => string;
  time: (v: string) => string;
  percent: (n: number) => string;
}

export const DEFAULT_LOCALE = "en-IN";
export const DEFAULT_CURRENCY = "INR";

/**
 * A rate for one pair, and the day it is from.
 *
 * Only ever used to annotate. Nothing here replaces a recorded amount.
 */
export interface ApproxRate {
  rate: number;
  /** The currency this rate converts FROM. */
  from: string;
  /** The day the rate is quoted for, for the sentence beside it. */
  asOf: string | null;
}

export function makeFormatting(
  locale: string,
  currency: string,
  approxRate?: ApproxRate | null
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
  const currencyFormatters = new Map<string, Intl.NumberFormat>();
  const currencyFormatter = (requested?: string | null) => {
    const code = requested || currency;
    const existing = currencyFormatters.get(code);
    if (existing) return existing;
    try {
      const made = new Intl.NumberFormat(safeLocale, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 2,
      });
      currencyFormatters.set(code, made);
      return made;
    } catch {
      const fallback = new Intl.NumberFormat(DEFAULT_LOCALE, {
        style: "currency",
        currency: DEFAULT_CURRENCY,
        maximumFractionDigits: 2,
      });
      currencyFormatters.set(code, fallback);
      return fallback;
    }
  };

  return {
    locale: safeLocale,
    currency,
    number: (n) => nf.format(n),
    // Imported money keeps the currency recorded with that row. The
    // project's currency remains the default for rows created here.
    money: (n, rowCurrency) => currencyFormatter(rowCurrency).format(n),
    approx: (n, rowCurrency) => {
      const source = rowCurrency || currency;
      // Already their money, nothing to estimate.
      if (source === currency) return null;
      if (!approxRate || !Number.isFinite(approxRate.rate) || approxRate.rate <= 0) return null;
      // A USD→INR rate says nothing about a EUR row. Two stores in two
      // currencies is the case this exists to refuse.
      if (approxRate.from !== source) return null;
      return `≈ ${currencyFormatter(currency).format(n * approxRate.rate)}`;
    },
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
