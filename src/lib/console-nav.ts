// The superadmin console's screens, in the sidebar's groups, once.
//
// A new screen is a page under src/app/[gate]/ and one line here: the
// sidebar, its search and the phone's menu all read this list, so nothing
// else has to learn that it exists. `to` is the path after the console's
// own address; "" is its first screen.
//
// Callers: src/components/PageFrame.tsx.

import {
  Bot,
  Cable,
  Coins,
  Compass,
  Eye,
  FlaskConical,
  GraduationCap,
  Inbox,
  MessagesSquare,
  ScrollText,
  ShieldCheck,
  ShoppingBag,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";

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
      { to: "spend", label: "Spend", icon: Coins, about: "What Luke's model calls cost, by day, model and account" },
      {
        to: "trouble",
        label: "Needs a look",
        icon: Eye,
        about: "Where something went wrong: failed turns, unhappy owners, churn, failing rules, workarounds",
      },
      {
        to: "learning",
        label: "Learning",
        icon: GraduationCap,
        about: "What Luke learned for each store, how it changed, and whether it helped",
      },
      {
        to: "agents",
        label: "Agents",
        icon: Bot,
        about: "How each of Luke's agents did: runs, verdicts, cost and time",
      },
      {
        to: "their-ai",
        label: "Their AI",
        icon: Cable,
        about: "What a merchant's own ChatGPT or Claude is told, and how its asks come out",
      },
      {
        to: "evals",
        label: "Evals",
        icon: FlaskConical,
        about: "Luke in whole conversations with a simulated owner, graded, run by run",
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
  {
    title: "Trust",
    screens: [
      { to: "access", label: "Access log", icon: ScrollText, about: "What administrators did, on whose account" },
      {
        to: "privacy",
        label: "Data & privacy",
        icon: ShieldCheck,
        about: "How long the record of Luke's turns is kept",
      },
    ],
  },
];

/** Past this many screens the sidebar offers a search, as every long list does. */
export const SEARCH_FROM = 8;
