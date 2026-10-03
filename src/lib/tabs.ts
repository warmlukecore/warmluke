// A section's views as tabs (features.tabs): the first is its own view,
// the rest are more views of the same rows. One place that says what
// each is called, for the tabs on the page, the validator and the card.
//
// Callers: src/components/GenericRenderer.tsx, src/lib/ai.ts, src/lib/describe.ts,
// src/lib/change-preview.ts, src/lib/judge.ts.

import type { FeatureSchema, ViewSpec } from "@/lib/types";

export type TabView = ViewSpec & { label?: string };

/** Past the section's own view, as many as a row of tabs holds on a phone. */
export const MAX_TABS = 4;

export const VIEW_NAMES: Record<ViewSpec["type"], string> = {
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  cards: "Cards",
  list: "List",
  custom: "Screen",
};

/** What a tab says: its label, a written screen's title, or what kind of view it is. */
export const tabName = (v: TabView): string =>
  (v.type === "custom" ? v.title?.trim() : v.label?.trim()) || VIEW_NAMES[v.type] || "View";

/** Every view of a section, its own first. */
export const sectionTabs = (f: FeatureSchema | null | undefined): TabView[] => [
  f?.view ?? { type: "table" },
  ...(f?.tabs ?? []),
];
