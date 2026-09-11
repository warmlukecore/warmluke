"use client";

// ─────────────────────────────────────────────────────────────
// Rows a link column can point at, keyed by section id.
//
// A context rather than props: Cell, the board card, the cards view
// and the record form all need it, and threading one map through five
// view components is more code than the feature.
// ─────────────────────────────────────────────────────────────

import { createContext, useContext, type ReactNode } from "react";

export interface LinkOption {
  id: string;
  label: string;
}

/** section id -> the rows in it, already labelled. */
export type LinkOptions = Record<string, LinkOption[]>;

const LinkContext = createContext<LinkOptions>({});

export function LinkProvider({
  options,
  children,
}: {
  options: LinkOptions;
  children: ReactNode;
}) {
  return <LinkContext.Provider value={options}>{children}</LinkContext.Provider>;
}

export function useLinkOptions(): LinkOptions {
  return useContext(LinkContext);
}

/**
 * What a stored link id should read as. An id with no matching row
 * means the target was deleted — say so rather than printing a uuid.
 */
export function useLinkLabel(): (linkTo: string | undefined, id: unknown) => string {
  const options = useLinkOptions();
  return (linkTo, id) => {
    const key = String(id ?? "").trim();
    if (!key) return "";
    const found = linkTo ? options[linkTo]?.find((o) => o.id === key) : undefined;
    return found?.label ?? "(deleted)";
  };
}
