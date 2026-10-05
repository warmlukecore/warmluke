"use client";

// ─────────────────────────────────────────────────────────────
// Rows a link column can point at, keyed by section id.
//
// A context rather than props: Cell, the board card, the cards view
// and the record form all need it, and threading one map through five
// view components is more code than the feature.
// ─────────────────────────────────────────────────────────────

import { createContext, useContext, type ReactNode } from "react";
import type { LinkTarget } from "@/lib/links";

export interface LinkOption {
  id: string;
  label: string;
  /** The row behind it, for a form to fill from (lib/links.ts). */
  data?: Record<string, unknown>;
}

/**
 * How a link finds its rows beyond those listed up front (5 Oct): a
 * store's list asked of the server as it is typed, narrowed by another
 * link already chosen; and what each link points at, for filling and
 * narrowing. Absent, a link offers only the rows listed.
 */
export interface LinkSource {
  search: (moduleId: string, q: string, narrow: { field: string; value: string } | null) => Promise<LinkOption[]>;
  targetOf: (moduleId: string) => LinkTarget | null;
}

const SourceContext = createContext<LinkSource | null>(null);

/** How links find and read their rows, where the app provides it. */
export function useLinkSource(): LinkSource | null {
  return useContext(SourceContext);
}

/** section id -> the rows in it, already labelled. */
export type LinkOptions = Record<string, LinkOption[]>;

const LinkContext = createContext<LinkOptions>({});

export function LinkProvider({
  options,
  source = null,
  children,
}: {
  options: LinkOptions;
  source?: LinkSource | null;
  children: ReactNode;
}) {
  return (
    <LinkContext.Provider value={options}>
      <SourceContext.Provider value={source}>{children}</SourceContext.Provider>
    </LinkContext.Provider>
  );
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
