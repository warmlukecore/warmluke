"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  makeFormatting,
  type Converter,
  type Formatting,
} from "@/lib/money";

// The formatting itself lives in money.ts, which has no React in it.
// Re-exported here so every existing import of "@/lib/format" keeps
// working.
export {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  makeFormatting,
  type Converter,
  type Formatting,
};

const FormatContext = createContext<Formatting>(
  makeFormatting(DEFAULT_LOCALE, DEFAULT_CURRENCY)
);

export function FormatProvider({
  locale,
  currency,
  convert,
  children,
}: {
  locale?: string | null;
  currency?: string | null;
  convert?: Converter | null;
  children: ReactNode;
}) {
  const value = useMemo(
    () => makeFormatting(locale || DEFAULT_LOCALE, currency || DEFAULT_CURRENCY, convert),
    [locale, currency, convert?.rate, convert?.from]
  );
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): Formatting {
  return useContext(FormatContext);
}
