// ─────────────────────────────────────────────────────────────
// The landing page.
//
// Server-rendered on purpose: the hero is chosen in middleware and
// arrives already decided, so nobody watches one headline turn into
// another, and the hero that gets measured is the hero that was read.
//
// One thing is being asked for — a demo. There is no Start Free, no
// Create Account, no Sign Up: the point of the page is to start a
// conversation with a business, not to collect an account from
// somebody who will never open it again. "Sign in" stays in the corner
// for people who already have one.
//
// The copy argues problems before technology. MCP, agents, tool
// calling and orchestration are how this works, not what it is for,
// and none of them belongs in a headline.
//
// The first screen is exactly one viewport — navbar and hero, with
// the dashboard preview running off the bottom edge and clipped
// there. Everything that argues the case scrolls underneath it, and
// none of that copy was cut: a page that looks expensive and says
// nothing is the thing this was meant to stop being.
//
// Light, where it used to be near-black. The app it sells has always
// been light, and a visitor who signed in met a different product.
//
// Two things must survive any redesign of this file. The hero is
// chosen upstream and its id is what LandingTracker records, so the
// headline on screen has to be the one that was decided. And every
// clickable thing carries data-cta, because that attribute is the
// whole click-tracking mechanism — a new button without one is a
// button nobody can measure.
//
// Callers: none — this is "/".
// ─────────────────────────────────────────────────────────────

import { Fragment } from "react";
import Image from "next/image";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { cycleCss, DEFAULT_HERO, headlineParts, heroById, resolveHero, VARIANT_COOKIE } from "@/lib/landing";
import { VARIANT_HEADER } from "@/proxy";
import { DemoForm, LandingTracker } from "@/components/Landing";

export const metadata = {
  title: "Warmluke: one place for your ecommerce business",
  description:
    "Connect your store, marketing, support and operations to Warmluke. Luke understands what's happening, helps you take action, and builds the tools your business needs.",
};

/** Asked six ways across the page; one place to change how it looks. */
function Cta({
  where,
  children = "Book a Demo",
  tone = "solid",
}: {
  where: string;
  children?: React.ReactNode;
  tone?: "solid" | "quiet";
}) {
  return (
    <a
      href="#book"
      // Not decoration. LandingTracker listens for a click on
      // anything carrying this, so a CTA without one is invisible to
      // every funnel number the page exists to produce.
      data-cta={where}
      className={
        tone === "solid"
          ? "inline-flex rounded-full bg-ink px-6 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
          : "inline-flex rounded-full border border-hair bg-white px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-neutral-400"
      }
    >
      {children}
    </a>
  );
}

/**
 * The little round play button beside the first call to action.
 *
 * It points at the demo like everything else rather than opening a
 * video. The film behind the hero is wallpaper with no sound and
 * nothing to say, so there is nothing for this to open. A play
 * triangle that does nothing is worse than one that takes you where
 * the page is asking you to go.
 */
function PlayCta() {
  return (
    <a
      href="#book"
      data-cta="hero_play"
      aria-label="Book a demo"
      className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-[0_2px_12px_rgb(0_0_0/0.08)] transition-colors hover:bg-neutral-50"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-ink" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    </a>
  );
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-t border-hair">
      <div className="mx-auto w-full max-w-5xl px-5 py-16 sm:py-20">
        {eyebrow && (
          <div className="mb-3 text-xs font-semibold tracking-widest text-accent">
            {eyebrow}
          </div>
        )}
        <h2 className="font-serif text-3xl leading-tight tracking-tight text-ink sm:text-[2.75rem]">
          {title}
        </h2>
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}

/**
 * What is plugged in, and a few of what is coming.
 *
 * Named on purpose, and short on purpose. An earlier version listed
 * all twenty and it read as a roadmap published to competitors and
 * as a list of twenty things not built. A handful people recognise,
 * then "and many more", says the same thing about reach without
 * promising each one by name.
 *
 * `ready` is the line that has to stay honest: exactly two of these
 * send anything today, and everything else is labelled soon
 * wherever it appears.
 */
const CONNECTORS: Array<{ name: string; ready: boolean }> = [
  { name: "Shopify", ready: true },
  { name: "Internal tools Luke builds", ready: true },
  { name: "Meta Ads", ready: false },
  { name: "Google Ads", ready: false },
  { name: "WhatsApp", ready: false },
  { name: "Instagram", ready: false },
];

/** The few that fit above a headline without crowding it. */
const HERO_CONNECTORS = [
  CONNECTORS[0],
  ...CONNECTORS.filter((c) => !c.ready).slice(0, 3),
];

/**
 * Each assistant in something close to its own colour.
 *
 * Presentation, so it lives here and not beside the copy: the hero
 * data says which names cycle, this says what they look like.
 *
 * Darkened a little from the brands' own values. These sit at
 * display size on white, over a film that is mostly pale, and the
 * published greens and oranges land near 3:1 against it — fine for
 * large text by the letter of the rule and thin in practice. A name
 * nobody has mapped simply inherits the headline's colour, which is
 * the safe direction to fail in.
 */
const LLM_TINT: Record<string, string> = {
  ChatGPT: "#0d8a6a",
  Claude: "#c2603f",
  Gemini: "#1a73e8",
  Qwen: "#6b4ee6",
};

/**
 * What Luke can be asked today, and what is honestly next.
 *
 * Split, because two of the six the brief wrote have no data behind
 * them at all — no advertising spend, no support conversations. A line
 * that cannot survive its own demo is worse than a shorter list.
 */
const ASKS = [
  {
    q: "Which products are running out?",
    a: "Low stock by variant and location, straight from what Shopify last told us.",
  },
  {
    q: "What happened in orders yesterday?",
    a: "Orders for a real calendar day in your store's own timezone. Totals, status, who ordered.",
  },
  {
    q: "Find this customer's orders.",
    a: "Look somebody up by name, email or phone and see what they bought.",
  },
  {
    q: "Our returns process is a mess. Make something better.",
    a: "Luke builds the tracker: fields, board, filters, the rules that move a return along.",
  },
  {
    q: "Create a dashboard for my operations team.",
    a: "A real internal section your team uses, shaped around how they actually work.",
  },
  {
    q: "Add an approval step before we refund.",
    a: "Luke writes the rule and shows you what it will do before anything runs.",
  },
];

/** Written down rather than implied. These need a connector first. */
const NEXT = [
  ["Advertising", "Wasted spend, campaign performance. Needs Meta and Google connected."],
  ["Support", "Recurring complaints, WhatsApp and reviews. Needs a support connector."],
];

const WATCHES: Array<[string, string]> = [
  ["Marketing", "A campaign suddenly starts spending without converting."],
  ["Operations", "Orders haven't been dispatched within the expected time."],
  ["Inventory", "A fast-moving product is approaching low stock."],
  ["Support", "The same customer complaint starts appearing repeatedly."],
  ["Performance", "Conversion rate changes significantly."],
  ["Returns", "Returns suddenly increase for a particular product."],
];

/**
 * What a connected assistant can actually do, in three groups.
 *
 * Said in the merchant's words, not ours. An earlier version listed
 * the tool names — store_overview, propose_change and the rest —
 * which is the API surface printed on the front door, and reads to
 * a merchant like somebody else's documentation. The capability is
 * the selling point; the function name is an implementation detail
 * they will never type.
 */
const BYO = [
  {
    head: "Ask it about your store",
    body: "Your assistant reads the real thing, not a description of it.",
    items: [
      "Orders for any day, in your store's own timezone",
      "A customer's whole history by name, email or phone",
      "What is running low, by variant and location",
      "Anything held in the sections your team built",
    ],
  },
  {
    head: "Have it build you something",
    body: "Describe the tool you need. Your assistant designs it and Warmluke checks the design against the same rules its own engine answers to.",
    items: [
      "A returns board, a COD queue, an approval step",
      "Checked before you ever see it",
      "Built into your app, not bolted beside it",
    ],
  },
  {
    head: "Stay in charge of it",
    body: "Nothing happens quietly.",
    items: [
      "Nothing is built until you say yes",
      "See what is waiting and what was built",
      "Put any build back with one undo",
    ],
  },
];

/** The three limits worth saying out loud, because they are the point. */
const BYO_LIMITS: Array<[string, string]> = [
  [
    "It cannot change your Shopify store",
    "The connection only reads from Shopify. Your assistant can look at orders, stock and customers; it cannot edit, cancel or refund anything there.",
  ],
  [
    "It cannot build without your approval",
    "Every design arrives as a request you read and approve. Refuse it and nothing happened.",
  ],
  [
    "Anything it built can be put back",
    "One undo reverses a build: the fields, the settings, the rules, the rows it seeded. It tells you anything it could not put back.",
  ],
];

const AREAS = [
  {
    name: "Operations",
    soon: false,
    items: ["Orders", "Inventory", "Customers", "Workflows", "Internal dashboards"],
    body: "Connect the operational parts of your store and give your team one place to understand what's happening and get things done.",
  },
  {
    name: "Marketing",
    soon: true,
    items: ["Meta Ads", "Google Ads", "Campaign monitoring", "Reporting"],
    body: "Once your ad accounts are connected, Luke can read campaign performance in the context of the orders it actually produced. Not connected yet.",
  },
  {
    name: "Support",
    soon: true,
    items: ["WhatsApp", "Customer conversations", "Reviews", "Common issues"],
    body: "Once support is connected, recurring problems stop being buried inside tickets. Not connected yet.",
  },
];

/**
 * The product, drawn rather than photographed.
 *
 * Coded because a screenshot goes stale the week after it is taken
 * and nobody notices. Every list named in here is one the app really
 * has — orders, draft orders, stock, discounts, returns — so the
 * picture stays honest as the product grows.
 *
 * Decorative, and told so: aria-hidden, no focus stops, no pointer
 * events. A person on a screen reader should meet the headline and
 * the demo form, not eleven fake table cells.
 */
function Preview() {
  const orders: Array<[string, string, string, string, string]> = [
    ["Today", "#1042 · Aman Kumar", "$1,299", "Paid", "text-emerald-600"],
    ["Today", "#1041 · Priya Sharma", "$598", "Pending", "text-amber-600"],
    ["Yesterday", "#1040 · Rahul Verma", "$149", "Paid", "text-emerald-600"],
    ["Yesterday", "#1039 · Sara Iqbal", "$2,897", "Refunded", "text-neutral-500"],
  ];
  const nav: Array<[string, string?]> = [
    ["Home"],
    ["Orders", "24"],
    ["Draft orders", "16"],
    ["Products"],
    ["Stock"],
    ["Discounts", "5"],
    ["Returns"],
    ["Customers"],
  ];

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none select-none overflow-hidden rounded-2xl p-3 text-[11px] md:p-4"
      style={{
        background: "rgb(255 255 255 / 0.55)",
        border: "1px solid rgb(255 255 255 / 0.6)",
        boxShadow: "var(--shadow-dashboard)",
      }}
    >
      <div className="overflow-hidden rounded-xl border border-hair bg-white text-left">
        {/* Top bar */}
        <div className="flex items-center gap-3 border-b border-hair px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Image
              src="/images/logowarmluke.png"
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 rounded-md object-cover"
            />
            <span className="font-medium text-ink">Warmluke</span>
            <span className="text-quiet">▾</span>
          </div>
          <div className="mx-auto hidden w-56 items-center justify-between rounded-md border border-hair px-2 py-1 text-quiet sm:flex">
            <span>Search orders, products…</span>
            <span className="rounded border border-hair px-1">⌘K</span>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:ml-0">
            <span className="rounded-full bg-accent px-2.5 py-1 font-medium text-white">
              Ask Luke
            </span>
            <span className="text-quiet">🔔</span>
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-semibold text-neutral-700">
              JB
            </span>
          </div>
        </div>

        <div className="flex">
          {/* Sidebar */}
          <div className="hidden w-40 shrink-0 border-r border-hair p-2 sm:block">
            {nav.map(([label, badge], i) => (
              <div
                key={label}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 ${
                  i === 0 ? "bg-neutral-100 font-medium text-ink" : "text-quiet"
                }`}
              >
                <span>{label}</span>
                {badge && (
                  <span className="rounded bg-neutral-100 px-1 text-[10px] text-neutral-600">
                    {badge}
                  </span>
                )}
              </div>
            ))}
            <div className="mt-3 px-2 text-[10px] font-semibold tracking-widest text-neutral-400">
              AUTOMATIONS
            </div>
            {["Low stock alert", "Refund approval", "Notifications", "Settings"].map((n) => (
              <div key={n} className="rounded-md px-2 py-1.5 text-quiet">
                {n}
              </div>
            ))}
          </div>

          {/* Main */}
          <div className="min-w-0 flex-1 bg-neutral-50/60 p-3">
            <div className="text-sm font-semibold text-ink">Welcome back, Jane</div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="rounded-full bg-accent px-2.5 py-1 font-medium text-white">
                Ask Luke
              </span>
              {["Import", "New section", "Orders", "Stock", "Export"].map((n) => (
                <span
                  key={n}
                  className="rounded-full border border-hair bg-white px-2.5 py-1 text-neutral-700"
                >
                  {n}
                </span>
              ))}
              <span className="text-quiet">Customise</span>
            </div>

            {/* Stacked on a phone. Side by side they are narrow
                enough that "Last 30 days" breaks over three lines,
                which reads as a broken layout rather than a small
                one. */}
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              {/* Revenue */}
              <div className="basis-0 flex-1 rounded-lg border border-hair bg-white p-3">
                <div className="flex items-center gap-1 text-quiet">
                  Revenue collected
                  <span className="text-emerald-600">✓</span>
                </div>
                <div className="mt-0.5 text-lg font-semibold tracking-tight text-ink">
                  $84,501
                  <span className="text-xs font-normal text-quiet">.32</span>
                </div>
                <div className="mt-1 flex gap-3 text-[10px] text-quiet">
                  <span>Last 30 days</span>
                  <span className="text-emerald-600">+$18.2K</span>
                  <span className="text-rose-600">−$4.9K</span>
                </div>
                {/* Hand-drawn rather than charted: one path is cheaper
                    than a charting library and cannot fail to load. */}
                <svg viewBox="0 0 220 64" className="mt-2 h-16 w-full" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="wl-rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(239 84% 67%)" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="hsl(239 84% 67%)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0 48 C 30 44, 44 24, 72 28 S 116 48, 140 34 S 186 8, 220 14 L 220 64 L 0 64 Z"
                    fill="url(#wl-rev)"
                  />
                  <path
                    d="M0 48 C 30 44, 44 24, 72 28 S 116 48, 140 34 S 186 8, 220 14"
                    fill="none"
                    stroke="hsl(239 84% 67%)"
                    strokeWidth="1.5"
                  />
                </svg>
              </div>

              {/* What is in the copy */}
              <div className="basis-0 flex-1 rounded-lg border border-hair bg-white p-3">
                <div className="flex items-center justify-between text-quiet">
                  <span>From your store</span>
                  <span className="flex gap-1.5">
                    <span>+</span>
                    <span>⋯</span>
                  </span>
                </div>
                {[
                  ["Orders", "1,284"],
                  ["Draft orders", "16"],
                  ["Products in stock", "342"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-3 text-xs">
                    <span className="text-neutral-600">{k}</span>
                    <span className="font-medium text-ink">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent orders */}
            <div className="mt-3 rounded-lg border border-hair bg-white p-3">
              <div className="font-medium text-ink">Recent orders</div>
              <div className="mt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-2 text-[10px]">
                {["Date", "Order", "Amount", "Status"].map((h) => (
                  <div key={h} className="text-quiet">
                    {h}
                  </div>
                ))}
                {orders.map(([date, who, amount, status, tone]) => (
                  <Fragment key={who}>
                    <div className="text-quiet">{date}</div>
                    <div className="truncate text-neutral-700">{who}</div>
                    <div className="text-right text-neutral-700">{amount}</div>
                    <div className={tone}>{status}</div>
                  </Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const one = (k: string) => {
    const v = q[k];
    return Array.isArray(v) ? v[0] : v;
  };

  // The proxy already decided, and says so on a header. Resolving
  // again here would roll a second time on a first visit — before the
  // cookie it just set has come back round — and render a hero that
  // nobody recorded.
  const decided = heroById((await headers()).get(VARIANT_HEADER));

  // Only if the proxy did not run at all: a direct render in a test,
  // or a deployment where the matcher missed. A malformed everything
  // still produces a headline rather than an empty hero.
  const jar = await cookies();
  const shown =
    decided ??
    resolveHero({
      wlVariant: one("wl_variant"),
      utmCampaign: one("utm_campaign"),
      assigned: jar.get(VARIANT_COOKIE)?.value,
    }).hero ??
    heroById(DEFAULT_HERO)!;

  const parts = headlineParts(shown);
  const names = shown.cycle?.through ?? [];
  const roll = cycleCss(names.length);

  return (
    <div className="font-ui bg-white text-ink">
      <LandingTracker variant={shown.id} />
      {/* Built from the list rather than written out, so the timing
          stays right whatever length it grows to. Inline styles are
          what the policy allows; inline scripts are the thing this
          page deliberately does without. */}
      {roll && <style dangerouslySetInnerHTML={{ __html: roll }} />}

      {/* ── The first screen: exactly one viewport ───────────── */}
      <div className="relative flex h-screen flex-col overflow-hidden">
        {/* The film, and what is behind it.
    
            The white panel is not decoration: it is what a visitor
            sees for the seconds before eighteen megabytes arrive, on
            a connection where they never do, and whenever the file
            itself is unreachable. A hero that is blank until a CDN
            answers is a hero that is sometimes blank.
    
            playsInline matters more than it looks — without it iOS
            Safari takes a muted autoplaying video fullscreen, and
            the page disappears on the phones most people open it
            on. */}
        <div className="absolute inset-0 z-0 flex items-center justify-center overflow-hidden bg-white">
          <span
            aria-hidden="true"
            className="font-serif select-none text-[16vw] leading-none tracking-tight text-neutral-50"
          >
            Warmluke
          </span>
          <video
            className="motion-safe:block absolute inset-0 hidden h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            // Nothing is announced and nothing is controlled: this is
            // wallpaper, and a screen reader meeting a video element
            // it cannot use is worse than not meeting one.
            aria-hidden="true"
            tabIndex={-1}
            preload="auto"
          >
            {/* Served from here rather than the host it was
                generated on. The original was eight seconds of
                1920x1080 at eighteen megabytes, with a soundtrack
                nothing ever plays, downloaded in full by every
                phone that opened the page. This is the same eight
                seconds at 1280 wide with the audio dropped: one
                megabyte, and behind a 55% white veil there is
                nothing to see between them. */}
            <source src="/video/hero.mp4" type="video/mp4" />
          </video>
          {/* A veil over whatever the film is doing. The copy on top
              is dark on white, and a frame that goes dark for half a
              second takes the headline with it. */}
          <div className="absolute inset-0 bg-white/55" />
        </div>

        {/* gap-3 rather than justify-between alone: at 375px with the
            longest call to action ("Book a Demo") the wordmark and
            "Sign in" met in the middle with nothing between them.
            The gap is what stops them touching whatever the variant
            puts in the button; the smaller type below is what keeps
            the gap from eating the button. */}
        <header className="relative z-10 flex items-center justify-between gap-3 px-5 py-5 sm:px-6 md:px-12 lg:px-20">
          <div className="flex shrink-0 items-center gap-2">
            {/* The mark carries its own dark tile, so it is clipped
                rather than sat on a background of ours. Sized and
                given dimensions so the navbar does not jump while
                it loads. */}
            <Image
              src="/images/logowarmluke.png"
              alt=""
              width={28}
              height={28}
              priority
              className="h-7 w-7 rounded-lg object-cover"
            />
            <span className="text-lg font-semibold tracking-tight sm:text-xl">Warmluke</span>
          </div>
          <nav className="flex items-center gap-5 text-sm md:gap-8">
            <a href="#luke" className="hidden text-quiet transition-colors hover:text-ink sm:inline">
              Luke
            </a>
            <a href="#uses" className="hidden text-quiet transition-colors hover:text-ink sm:inline">
              Use cases
            </a>
            <a
              href="#integrations"
              className="hidden text-quiet transition-colors hover:text-ink sm:inline"
            >
              Integrations
            </a>
            <a href="#mcp" className="hidden text-quiet transition-colors hover:text-ink md:inline">
              Your own AI
            </a>
            {/* nowrap: at 320px it broke into "Sign / in" over two
                lines beside a button that was still on one. */}
            <Link href="/login" className="whitespace-nowrap text-quiet transition-colors hover:text-ink">
              Sign in
            </Link>
            <a
              href="#book"
              data-cta="nav"
              className="shrink-0 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 sm:px-5 sm:text-sm"
            >
              {shown.cta}
            </a>
          </nav>
        </header>

        {/* min-h-0 so the preview below can be clipped rather than
            stretching this column past the viewport it is meant to
            fit inside. */}
        <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col items-center px-5 text-center">
          {/* What is plugged in, before the promise. A visitor's
              first question about a tool like this is "does it
              reach my stack", and one line of prose answered it for
              one system while saying nothing about the rest. */}
          <div
            className="rise mb-6 flex flex-wrap items-center justify-center gap-1.5"
            style={{ "--rise-from": "10px", "--rise-for": "0.5s" } as React.CSSProperties}
          >
            {HERO_CONNECTORS.map((c) =>
              c.ready ? (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
                >
                  <span aria-hidden="true" className="text-[8px] text-emerald-600">
                    ●
                  </span>
                  {c.name}
                </span>
              ) : (
                // Not decoration, and not a dead label either. Somebody
                // reading "Meta Ads · soon" wants to say "that is the
                // one I need", so the chip is the place to say it.
                //
                // Each carries its own data-cta, which the tracker
                // stores verbatim: after a month the clicks say which
                // connector merchants actually ask for, which is a
                // better way to choose the next one than guessing.
                <a
                  key={c.name}
                  href="#book"
                  data-cta={`connector_${c.name.toLowerCase().replace(/\s+/g, "_")}`}
                  title={`Need ${c.name}? Book a demo and tell us.`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hair bg-white px-3 py-1 text-xs text-quiet transition-colors hover:border-neutral-400 hover:text-ink"
                >
                  {c.name}
                  <span className="text-[10px] uppercase tracking-wide text-neutral-400">soon</span>
                </a>
              )
            )}
            {/* No number. A count invites the question "which
                twenty?", and the answer would be a roadmap on the
                front page. This says there is more without listing
                what a competitor would like to read. */}
            <a
              href="#integrations"
              data-cta="connectors_more"
              className="inline-flex items-center rounded-full px-2 py-1 text-xs text-neutral-400 underline underline-offset-2 transition-colors hover:text-ink"
            >
              and many more
            </a>
          </div>

          {/* The variant's own line, when it has one. It used to sit
              in the badge's place, and the strip is not a reason to
              stop testing it. */}
          {shown.eyebrow && (
            <div
              className="rise mb-3 text-xs font-semibold tracking-widest text-accent"
              style={{ "--rise-from": "10px", "--rise-for": "0.5s", "--rise-after": "0.05s" } as React.CSSProperties}
            >
              {shown.eyebrow}
            </div>
          )}

          {/* clamp, not fixed steps: eight headlines run through here
              and the longest is four times the shortest. A size that
              suits one pushes another off the bottom of the screen. */}
          <h1
            className="rise font-serif max-w-4xl text-[clamp(2rem,5.2vw,4.5rem)] leading-[0.98] tracking-tight"
            style={{ "--rise-after": "0.1s" } as React.CSSProperties}
          >
            {parts.map((part, i) =>
              part.kind === "italic" ? (
                <em key={i} className="italic">
                  {part.text}
                </em>
              ) : part.kind === "cycle" && roll ? (
                // Each name is collapsed outright when its turn
                // ends, so the line is only ever as wide as the one
                // being shown and the full stop after it never
                // drifts. A stack in one grid cell was tried first
                // and left the stop floating a letter away from the
                // shortest name. The first name is the real word
                // from the headline, which is what a crawler and a
                // reader with no CSS get. See cycleCss.
                <span key={i} className="whitespace-nowrap">
                  {names.map((name, n) => (
                    <span
                      key={name}
                      aria-hidden={n > 0 ? "true" : undefined}
                      className="wl-cycle whitespace-nowrap"
                      style={
                        {
                          animationDelay: `${(n * 2.2).toFixed(2)}s`,
                          // The name carries its full stop; the tint is keyed on the name alone.
                          color: LLM_TINT[name.replace(/[.,!?]+$/, "")],
                        } as React.CSSProperties
                      }
                    >
                      {name}
                    </span>
                  ))}
                </span>
              ) : (
                <span key={i}>{part.text}</span>
              )
            )}
          </h1>

          <p
            className="rise mt-4 max-w-[650px] text-base leading-relaxed text-quiet md:text-lg"
            style={{ "--rise-after": "0.2s" } as React.CSSProperties}
          >
            {shown.sub}
          </p>

          <div
            className="rise mt-5 flex items-center gap-3"
            style={{ "--rise-after": "0.3s" } as React.CSSProperties}
          >
            <Cta where="hero">{shown.cta}</Cta>
            {shown.secondary ? <Cta where="hero_secondary" tone="quiet">{shown.secondary}</Cta> : <PlayCta />}
          </div>

          {shown.supporting && (
            <p
              className="rise mt-4 text-xs tracking-wide text-neutral-400"
              style={{ "--rise-after": "0.4s" } as React.CSSProperties}
            >
              {shown.supporting}
            </p>
          )}

          <div
            className="rise mt-8 w-full max-w-5xl"
            style={{ "--rise-from": "30px", "--rise-for": "0.8s", "--rise-after": "0.5s" } as React.CSSProperties}
          >
            <Preview />
          </div>
        </main>
      </div>

      {/* ── One context ──────────────────────────────────────── */}
      <Section id="integrations" title="Your whole ecommerce business. One context.">
        <div className="flex flex-wrap gap-2">
          {CONNECTORS.map((c) => (
            <span
              key={c.name}
              className={
                c.ready
                  ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-sm text-emerald-800"
                  : "rounded-lg border border-hair px-3.5 py-2 text-sm text-neutral-400"
              }
            >
              {c.name}{" "}
              <span className={c.ready ? "text-emerald-600" : "text-neutral-300"}>
                {c.ready ? "· connected" : "· soon"}
              </span>
            </span>
          ))}
          <span className="rounded-lg border border-dashed border-hair px-3.5 py-2 text-sm text-neutral-400">
            and many more
          </span>
        </div>
        <p className="mt-4 text-sm text-neutral-400">
          Whatever a growing business runs on: payments, shipping, accounting, marketplaces, the
          spreadsheet your team actually lives in.{" "}
          <a href="#book" data-cta="connectors_ask" className="text-accent underline underline-offset-2 hover:opacity-80">
            Tell us yours on the demo
          </a>
          .
        </p>
        <p className="mt-6 max-w-2xl text-quiet">
          Your business already has the data. The problem is that it&apos;s spread across different
          systems. Warmluke brings that context together so Luke can understand the whole picture,
          not one dashboard at a time.
        </p>
      </Section>

      {/* ── Luke doing real work ─────────────────────────────── */}
      <Section id="luke" title="Ask Luke like you'd ask someone on your team.">
        <div className="grid gap-4 sm:grid-cols-2">
          {ASKS.map((x) => (
            <div key={x.q} className="rounded-2xl border border-hair bg-neutral-50 p-5">
              <div className="font-serif text-lg text-ink">
                &ldquo;{x.q}&rdquo;
              </div>
              <p className="mt-2 text-sm leading-relaxed text-quiet">{x.a}</p>
            </div>
          ))}
        </div>
        {/* One of those questions, actually answered.
    
            This exchange lived in the old hero and is kept word for
            word, because the words were the careful part: an earlier
            version of it showed sessions holding steady and a
            campaign overspending, none of which exists anywhere in
            the product. A mock is a promise. This one can be kept. */}
        <div className="mt-8 overflow-hidden rounded-2xl border border-hair bg-white shadow-[0_2px_24px_rgb(0_0_0/0.04)]">
          <div className="flex items-center gap-2 border-b border-hair px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="ml-2 text-xs text-neutral-400">Warmluke · Luke</span>
          </div>
          <div className="space-y-4 p-5 sm:p-7">
            <div className="ml-auto max-w-md rounded-2xl rounded-br-sm bg-accent/10 px-4 py-3 text-sm text-ink">
              What&apos;s running low?
            </div>
            <div className="max-w-xl rounded-2xl rounded-bl-sm border border-hair bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-neutral-400">
                <span className="rounded border border-hair bg-white px-1.5 py-0.5">Shopify</span>
                <span className="rounded border border-hair bg-white px-1.5 py-0.5">synced 6 min ago</span>
              </div>
              Three variants are under ten at your main location: Classic Tee / M (4),
              Canvas Tote (7), Ceramic Mug / White (9). Want a low-stock board your team
              can work from?
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-hair bg-neutral-50 p-5">
          <div className="text-xs font-semibold tracking-widest text-neutral-400">
            NOT YET, AND WE&apos;D RATHER SAY SO
          </div>
          <div className="mt-3 space-y-2">
            {NEXT.map(([area, what]) => (
              <div key={area} className="text-sm text-quiet">
                <span className="text-neutral-700">{area}:</span> {what}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-8">
          <Cta where="asks">See what Luke could do for your store →</Cta>
        </div>
      </Section>

      {/* ── Proactive ────────────────────────────────────────── */}
      <Section title="Luke doesn't have to wait for you to ask.">
        <p className="max-w-2xl text-quiet">
          Traditional dashboards are useful only when somebody remembers to check them. Luke can
          help monitor the business continuously and surface important changes.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {WATCHES.map(([area, what]) => (
            <div key={area} className="rounded-xl border border-hair bg-neutral-50 p-4">
              <div className="text-xs font-semibold tracking-widest text-accent">
                {area.toUpperCase()}
              </div>
              <p className="mt-1.5 text-sm text-neutral-700">{what}</p>
            </div>
          ))}
        </div>
        <p className="font-serif mt-8 text-2xl text-ink sm:text-3xl">
          Less checking dashboards. More knowing what needs your attention.
        </p>
      </Section>

      {/* ── Stop adding another app ──────────────────────────── */}
      <Section id="uses" eyebrow="INSTEAD OF BUYING ANOTHER APP" title="Stop adding another app.">
        <p className="max-w-2xl text-quiet">
          Your business will eventually need something your current software doesn&apos;t do.
          Usually that means searching the app store, trying three SaaS products, paying another
          subscription, and changing your workflow around the software.
        </p>
        <p className="font-serif mt-6 text-2xl text-ink">
          Need something? Tell Luke.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            "returns dashboard",
            "COD verification workflow",
            "inventory alert system",
            "customer support tool",
            "internal approval workflow",
            "custom reporting dashboard",
            "team operations tool",
            "store-specific automation",
          ].map((n) => (
            <span
              key={n}
              className="rounded-full border border-hair px-3.5 py-1.5 text-xs text-quiet"
            >
              {n}
            </span>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-quiet">
          Your business shouldn&apos;t have to change how it works because another SaaS product was
          designed for everyone.
        </p>
      </Section>

      {/* ── Three areas ──────────────────────────────────────── */}
      <Section title="One Luke. Across your business.">
        <div className="grid gap-5 sm:grid-cols-3">
          {AREAS.map((a) => (
            <div
              key={a.name}
              className={`rounded-2xl border p-5 ${
                a.soon
                  ? "border-hair bg-neutral-50 text-neutral-400"
                  : "border-hair bg-white"
              }`}
            >
              <div className="font-serif flex items-center gap-2 text-xl">
                {a.name}
                {a.soon && (
                  <span className="rounded border border-hair px-1.5 py-0.5 text-[10px] font-medium tracking-widest text-neutral-400">
                    NEXT
                  </span>
                )}
              </div>
              <ul className="mt-3 space-y-1 text-sm text-quiet">
                {a.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-quiet">{a.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Against a general-purpose assistant ──────────────── */}
      <Section title="AI is more useful when it actually knows your business.">
        <p className="max-w-2xl text-quiet">
          ChatGPT and Claude are great general-purpose AI tools. But unless you repeatedly give them
          your store data, advertising data, support context and operational information, they
          don&apos;t know what&apos;s happening inside your business. Luke does.
        </p>
        <p className="mt-5 max-w-2xl text-quiet">
          Prefer ChatGPT or Claude? Warmluke can connect to them too, so you can reach your business
          context from the AI tools you already use.
        </p>
        <p className="font-serif mt-8 text-2xl text-ink sm:text-3xl">
          Stop explaining your business to AI every time you start a conversation.
        </p>
      </Section>

      {/* ── Bring your own assistant ─────────────────────────── */}
      <Section
        id="mcp"
        eyebrow="CLAUDE OR CHATGPT, CONNECTED"
        title="Bring your own AI. Give it the keys to your business."
      >
        <p className="max-w-2xl text-quiet">
          Warmluke speaks MCP, the standard Claude and ChatGPT use to reach outside tools. Connect
          it once and the assistant you already pay for stops guessing about your business, and
          starts building inside it.
        </p>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {BYO.map((g) => (
            <div key={g.head} className="rounded-2xl border border-hair bg-white p-5">
              <div className="font-serif text-lg text-ink">{g.head}</div>
              <p className="mt-2 text-sm leading-relaxed text-quiet">{g.body}</p>
              <ul className="mt-4 space-y-1.5">
                {g.items.map((t) => (
                  <li key={t} className="flex gap-2 text-sm leading-relaxed text-neutral-700">
                    <span aria-hidden="true" className="text-accent">
                      ·
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="font-serif mt-10 text-2xl text-ink sm:text-3xl">
          Your assistant does the thinking. Warmluke does the building, and the checking.
        </p>
        <p className="mt-3 max-w-2xl text-quiet">
          Ask your own Claude for a returns board, a COD verification queue, an approval step before
          refunds. It writes the design; Warmluke puts it through the same validator its own engine
          answers to, and only then asks you. Two assistants, one set of rules.
        </p>

        <div className="mt-8 rounded-2xl border border-hair bg-neutral-50 p-5">
          <div className="text-xs font-semibold tracking-widest text-neutral-400">
            AND WHAT IT CANNOT DO
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {BYO_LIMITS.map(([head, body]) => (
              <div key={head}>
                <div className="text-sm font-medium text-ink">{head}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-quiet">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8">
          <Cta where="mcp">Connect your own AI →</Cta>
        </div>
      </Section>

      {/* ── How it works ─────────────────────────────────────── */}
      <Section title="How it works">
        <div className="grid gap-5 sm:grid-cols-3">
          {[
            [
              "1. Connect your business",
              "Connect the tools and systems your ecommerce team already uses.",
            ],
            ["2. Talk to Luke", "Ask questions, identify problems, or tell Luke what you need."],
            [
              "3. Get something done",
              "Analyse data, monitor the business, create workflows or build functionality specific to your company.",
            ],
          ].map(([t, b]) => (
            <div key={t} className="rounded-2xl border border-hair bg-neutral-50 p-5">
              <div className="font-serif text-lg">{t}</div>
              <p className="mt-2 text-sm leading-relaxed text-quiet">{b}</p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Cta where="how" />
        </div>
      </Section>

      {/* ── Book ─────────────────────────────────────────────── */}
      <section id="book" className="border-t border-hair">
        <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
          <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-[2.75rem]">
            What would you ask Luke to fix first?
          </h2>
          <p className="mt-4 text-quiet">
            Connect your ecommerce business to Warmluke and see what Luke could do for your team. No
            generic sales pitch. Show us how your business works today and we&apos;ll show you what
            Warmluke can do with it.
          </p>
          <div className="mt-8">
            <DemoForm variant={shown.id} />
          </div>
        </div>
      </section>

      <footer className="border-t border-hair py-8">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-5 text-xs text-neutral-400">
          <span>Warmluke. One intelligent operating layer for your ecommerce business.</span>
          <span className="flex gap-4">
            <Link href="/privacy" className="hover:text-neutral-700">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-neutral-700">
              Terms
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
