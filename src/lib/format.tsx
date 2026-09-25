"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, makeFormatting, type ApproxRate, type Formatting } from "@/lib/money";

// The formatting itself lives in money.ts, which has no React in it.
// Re-exported here so every existing import of "@/lib/format" keeps
// working.
export { DEFAULT_CURRENCY, DEFAULT_LOCALE, makeFormatting, type ApproxRate, type Formatting };

const FormatContext = createContext<Formatting>(makeFormatting(DEFAULT_LOCALE, DEFAULT_CURRENCY));

export function FormatProvider({
  locale,
  currency,
  approxRate,
  children,
}: {
  locale?: string | null;
  currency?: string | null;
  /** Lets an imported amount carry a rough note in the project's own
   *  money. It never changes what `money` prints. */
  approxRate?: ApproxRate | null;
  children: ReactNode;
}) {
  const value = useMemo(
    () => makeFormatting(locale || DEFAULT_LOCALE, currency || DEFAULT_CURRENCY, approxRate),
    // The object is rebuilt by the caller on every render, so depend on
    // what is in it rather than on its identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [locale, currency, approxRate?.rate, approxRate?.from, approxRate?.asOf]
  );
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): Formatting {
  return useContext(FormatContext);
}
