"use client";

// ─────────────────────────────────────────────────────────────
// Number, money and date formatting for the project's own locale.
// It used to be en-US/USD in the renderer, which quietly told an
// Indian shop their ₹1,250 was $1,250. Locale lives on the project
// row; India is the default, not the only choice.
// ─────────────────────────────────────────────────────────────

import { createContext, useContext, useMemo, type ReactNode } from "react";

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

export function makeFormatting(locale: string, currency: string): Formatting {
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
    money: (n) => cf.format(n),
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

const FormatContext = createContext<Formatting>(
  makeFormatting(DEFAULT_LOCALE, DEFAULT_CURRENCY)
);

export function FormatProvider({
  locale,
  currency,
  children,
}: {
  locale?: string | null;
  currency?: string | null;
  children: ReactNode;
}) {
  const value = useMemo(
    () => makeFormatting(locale || DEFAULT_LOCALE, currency || DEFAULT_CURRENCY),
    [locale, currency]
  );
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): Formatting {
  return useContext(FormatContext);
}
