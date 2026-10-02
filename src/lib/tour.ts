// The tour's stops (components/Tour.tsx), in one place for the app that
// shows them and the admin page that rewords them (0157).
//
// Each stop points at a real part of the screen, so the stops live here,
// beside the screen, and change with it. Only their words can be changed
// from the admin page: tour_settings.copy holds those, by stop key, where
// they differ from what is written here.

import type { TourStop } from "@/components/Tour";

export type TourCopy = Record<string, { title?: string; body?: string }>;

type Def = TourStop & {
  /** Shown only where it applies: a project with a store, a person who can build. */
  needs?: "store" | "build";
};

/** The sidebar is a drawer on a phone: its stops point at the button that opens it. */
const MENU = '[aria-label="Open sections"]';

export const TOUR_STOPS: Def[] = [
  {
    key: "welcome",
    title: "Welcome to Warmluke",
    body: "A quick look round, a few stops. Escape leaves it at any time.",
  },
  {
    key: "store",
    needs: "store",
    target: `[data-tour="store"], ${MENU}`,
    title: "Your store",
    body: "Orders, products and customers from Shopify, kept up to date. Open any of them to search, sort and filter it.",
  },
  {
    key: "sync",
    needs: "store",
    target: `[data-tour="sync"], ${MENU}`,
    title: "It keeps syncing",
    body: "How your store stands lives here. While it is still coming in, what is open grows with it, and Check reads it again.",
  },
  {
    key: "luke",
    needs: "build",
    target: 'aside[aria-label="Luke"], [data-tour="ask-luke"] > *',
    title: "Ask Luke",
    body: "Ask anything about your store in your own words: which orders are late, who buys the most, what is running low.",
  },
  {
    key: "build",
    needs: "build",
    target: `[data-tour="build"], ${MENU}`,
    title: "Build what you need",
    body: "Describe the tool you wish you had, and Luke builds it here around how you work. Nothing in your shop changes unless you say yes.",
  },
];

/** The stops this person sees, in the words the administrator chose. */
export function tourStops(copy: TourCopy | null | undefined, has: { store: boolean; build: boolean }): TourStop[] {
  return TOUR_STOPS.filter((s) => !s.needs || has[s.needs]).map((s) => ({
    key: s.key,
    target: s.target,
    title: copy?.[s.key]?.title?.trim() || s.title,
    body: copy?.[s.key]?.body?.trim() || s.body,
  }));
}
