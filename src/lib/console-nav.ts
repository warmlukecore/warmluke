// The superadmin console's screens, in the sidebar's groups, once.
//
// A new screen is a page under src/app/[gate]/ and one line here: the
// sidebar, its search and the phone's menu all read this list, so nothing
// else has to learn that it exists. `to` is the path after the console's
// own address; "" is its first screen.
//
// Callers: src/components/PageFrame.tsx.

import { Compass, Inbox, MessagesSquare, ShoppingBag, UserPlus, Users, type LucideIcon } from "lucide-react";

export type ConsoleScreen = { to: string; label: string; icon: LucideIcon; about: string };
export type ConsoleGroup = { title: string; screens: ConsoleScreen[] };

export const CONSOLE_NAV: ConsoleGroup[] = [
  {
    title: "People",
    screens: [
      { to: "", label: "Accounts", icon: Users, about: "Who uses Warmluke, and what is switched on for them" },
      {
        to: "invites",
        label: "Invites",
        icon: UserPlus,
        about: "Links that open a sign-up with what is known filled in",
      },
      { to: "demos", label: "Early access", icon: Inbox, about: "Who asked for a demo, and where each one stands" },
    ],
  },
  {
    title: "Luke",
    screens: [
      {
        to: "conversations",
        label: "Conversations",
        icon: MessagesSquare,
        about: "Any conversation, with every turn's trace",
      },
    ],
  },
  {
    title: "Stores",
    screens: [{ to: "shopify", label: "Shopify apps", icon: ShoppingBag, about: "Apps stores connect through" }],
  },
  {
    title: "Product",
    screens: [{ to: "tour", label: "Tour", icon: Compass, about: "The first look round the app, and who saw it" }],
  },
];

/** Past this many screens the sidebar offers a search, as every long list does. */
export const SEARCH_FROM = 8;
