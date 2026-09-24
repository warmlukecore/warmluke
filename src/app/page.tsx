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

import Link from "next/link";
import { cookies, headers } from "next/headers";
import { cycleCss, DEFAULT_HERO, headlineParts, heroById, resolveHero, VARIANT_COOKIE } from "@/lib/landing";
import { VARIANT_HEADER } from "@/proxy";
import {
  Bell,
  Blocks,
  Check,
  CircleCheck,
  CreditCard,
  Hammer,
  Lock,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  Package,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { AskLuke, DemoForm, FloatingNav, LandingTracker, NavLinks, type Ask } from "@/components/Landing";
import { whatCanChange, whatNeverChanges } from "@/lib/store-actions";
import { Logo } from "@/components/ui/Logo";
import { StorePreview } from "@/components/StorePreview";
import { FIGURES, FOLLOW_UP, LOW, LOW_STOCK, Spell, lastSync, money, spell, variantName } from "@/lib/sample-store";
import { ago } from "@/lib/when";

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
      {/* reveal: comes up as it scrolls into view, where the browser can. */}
      <div className="reveal mx-auto w-full max-w-5xl px-5 py-16 sm:py-20">
        {eyebrow && (
          <div className="mb-3 text-sm font-medium text-accent">{eyebrow}</div>
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
 * What is plugged in, and what the team sets up alongside it.
 *
 * Named on purpose, and short on purpose. An earlier version listed
 * all twenty and it read as a roadmap published to competitors and
 * as a list of twenty things not built. A handful people recognise,
 * then "and many more", says the same thing about reach without
 * promising each one by name.
 *
 * `ready` is the line that has to stay honest: exactly two of these
 * are connected in the app today. The rest are set up by the team,
 * and say so wherever they appear, never "connected".
 */
const CONNECTORS: Array<{ name: string; ready: boolean; logo?: string }> = [
  { name: "Shopify", ready: true, logo: "/logos/shopify.svg" },
  { name: "Internal tools Luke builds", ready: true },
  { name: "Meta Ads", ready: false, logo: "/logos/meta.svg" },
  { name: "Google Ads", ready: false, logo: "/logos/google.svg" },
  { name: "WhatsApp", ready: false, logo: "/logos/whatsapp.svg" },
  { name: "Instagram", ready: false, logo: "/logos/instagram.svg" },
];

const logoOf = (name: string) => CONNECTORS.find((c) => c.name === name)?.logo;

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
 * What Luke can be asked today, and what it answers.
 *
 * Only what the product can do: an earlier brief had advertising spend
 * and support conversations in here, with no data behind either. A
 * line that cannot survive its own demo is worse than a shorter list.
 * The facts in the answers are read from the sample store the
 * dashboard above runs on (src/lib/sample-store.ts), so the stock Luke
 * calls low is the stock the dashboard shows low, and the customer it
 * finds is one a visitor can click on up there.
 */
/** Yesterday in the sample store, said the way Luke says it. */
function yesterdayReply() {
  const { orders, collected, awaiting, toSend } = FIGURES.yesterday;
  const not = toSend === 1 ? "hasn't" : "haven't";
  return `Yesterday, in your store's timezone: ${orders} orders and ${money(collected)} collected. ${Spell(awaiting)} ${awaiting === 1 ? "is" : "are"} still awaiting payment on cash on delivery, and ${spell(toSend)} ${not} been sent yet. Want the ${spell(toSend)} that ${not} gone?`;
}

const ASKS: Ask[] = [
  {
    q: "Which products are running out?",
    a: "Low stock by variant and location, straight from what Shopify last told us.",
    said: "What's running low?",
    reply: `${Spell(LOW.length)} variants are under ${spell(LOW_STOCK)} at your main location: ${LOW.map((v) => `${variantName(v)} (${v.stock})`).join(", ")}. Want a low-stock board your team can work from?`,
    from: ["Shopify"],
    show: "stock",
  },
  {
    q: "What happened in orders yesterday?",
    a: "Orders for a real calendar day in your store's own timezone. Totals, status, who ordered.",
    reply: yesterdayReply(),
    from: ["Shopify"],
    show: "orders",
  },
  {
    q: "Find this customer's orders.",
    a: "Look somebody up by name, email or phone and see what they bought.",
    said: `Find ${FOLLOW_UP.name}'s orders.`,
    reply: `${FOLLOW_UP.name} has ${spell(FOLLOW_UP.orders.length)} orders this month, ${money(FOLLOW_UP.spent)} in all. The latest, #${FOLLOW_UP.orders[0].number}, is still awaiting payment. Their phone and email are on the order if you want to follow up.`,
    from: ["Shopify"],
    show: "customer",
  },
  {
    q: "Our returns process is a mess. Make something better.",
    a: "Luke builds the tracker: fields, board, filters, the rules that move a return along.",
    reply:
      "Here is a Returns tracker for you to look over: the order, the reason and the refund on each return, a board from requested to refunded, and a rule that moves a return along once it arrives. Nothing is built until you approve it.",
    from: ["Design", "waiting for your yes"],
    show: "returns",
  },
  {
    q: "Create a dashboard for my operations team.",
    a: "A real internal section your team uses, shaped around how they actually work.",
    reply:
      "Here is an Operations section: orders still to send, stock running low and today's returns on one screen. Approve it and it appears in your team's menu.",
    from: ["Design", "waiting for your yes"],
    show: "dashboard",
  },
  {
    q: "Add an approval step before we refund.",
    a: "Luke writes the rule and shows you what it will do before anything runs.",
    reply:
      "Here is the rule, and what it will do: a refund waits for a manager's yes before it is marked done. It applies to new refunds only, and nothing runs until you say yes.",
    from: ["Rule", "waiting for your yes"],
    show: "rule",
  },
];

/**
 * What Luke noticed, drawn as the alerts it would raise. Marketing and
 * support come from accounts the team sets up, and say so, the same as
 * everywhere else on the page.
 */
const WATCHES: Array<{ area: string; what: string; icon: LucideIcon; when: string; team?: boolean }> = [
  { area: "Inventory", what: "A fast-moving product is approaching low stock.", icon: Package, when: "just now" },
  { area: "Operations", what: "Orders haven't been dispatched within the expected time.", icon: Truck, when: "12 min ago" },
  { area: "Returns", what: "Returns suddenly increase for a particular product.", icon: RotateCcw, when: "1 h ago" },
  { area: "Performance", what: "Conversion rate changes significantly.", icon: TrendingUp, when: "3 h ago" },
  { area: "Marketing", what: "A campaign suddenly starts spending without converting.", icon: Megaphone, when: "yesterday", team: true },
  { area: "Support", what: "The same customer complaint starts appearing repeatedly.", icon: MessageCircle, when: "yesterday", team: true },
];

/** What a merchant would otherwise go and buy, one app at a time. */
const USUAL = ["A returns app", "A stock alert app", "A reporting app", "An approval tool"];

/** What Luke is asked for instead. */
const TOOLS = [
  "returns dashboard",
  "COD verification workflow",
  "inventory alert system",
  "customer support tool",
  "internal approval workflow",
  "custom reporting dashboard",
  "team operations tool",
  "store-specific automation",
];

/** "an inventory alert system", "a returns dashboard": said as a sentence says it. */
const withArticle = (t: string) => `${/^[aeiou]/i.test(t) ? "an" : "a"} ${t}`;

/** Where the footer goes: the page's own sections, then the rest of the site. */
const FOOTER_LINKS: Array<[string, string]> = [
  ["Luke", "#luke"],
  ["Use cases", "#uses"],
  ["Integrations", "#integrations"],
  ["Your own AI", "#mcp"],
  ["Book a demo", "#book"],
  ["Sign in", "/login"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
];

const BOOK_POINTS = [
  "Shown on your own store, not a sample one",
  "Your questions, in your words",
];

/**
 * What a connected assistant can actually do, in two lines; the
 * questions themselves are Ask Luke's, higher up the page.
 *
 * Said in the merchant's words, not ours. An earlier version listed
 * the tool names — store_overview, propose_change and the rest —
 * which is the API surface printed on the front door, and reads to
 * a merchant like somebody else's documentation. The capability is
 * the selling point; the function name is an implementation detail
 * they will never type.
 */
const BYO: Array<{ head: string; body: string; icon: LucideIcon }> = [
  {
    icon: MessageSquareText,
    head: "Ask it about your store",
    body: "Orders, stock and customers, read from the store itself rather than from whatever you paste into the chat.",
  },
  {
    icon: Hammer,
    head: "Have it build you something",
    body: "Describe the tool you need. Your assistant designs it and Warmluke checks the design against the same rules its own engine answers to.",
  },
];

/**
 * The three limits worth saying out loud, because they are the point.
 *
 * The first one said "it cannot change your Shopify store" for a day
 * after it could. What it can change is read off the registry now, so
 * the day a fifth change is added this sentence says so on its own.
 */
const BYO_LIMITS: Array<[string, string, LucideIcon]> = [
  [
    "It cannot change your shop without you",
    `Your assistant can look at orders, stock and customers, and ask to ${whatCanChange()}. Each change waits for your yes, and it cannot give one for you. It cannot ${whatNeverChanges()} anything at all.`,
    Lock,
  ],
  [
    "It cannot build without your approval",
    "Every design arrives as a request you read and approve. Refuse it and nothing happened.",
    CircleCheck,
  ],
  [
    "Anything it built can be put back",
    "One undo reverses a build: the fields, the settings, the rules, the rows it seeded. It tells you anything it could not put back.",
    Undo2,
  ],
];

/** Where the i-th of n sits on a ring, as a share of the ring's box, starting at the top. */
function onRing(i: number, n: number, turn = 0): React.CSSProperties {
  const a = (((i / n) * 360 + turn) * Math.PI) / 180;
  return { left: `${(50 + 50 * Math.sin(a)).toFixed(2)}%`, top: `${(50 - 50 * Math.cos(a)).toFixed(2)}%` };
}

/** A logo on a white tile; what Luke builds, which has no logo, as blocks. */
function Planet({ name, ready }: { name: string; ready: boolean }) {
  const logo = logoOf(name);
  return (
    <div
      className={`relative flex h-12 w-12 items-center justify-center rounded-2xl border bg-white shadow-[0_10px_30px_-12px_rgb(0_0_0/0.3)] sm:h-14 sm:w-14 ${
        ready ? "border-emerald-200" : "border-hair"
      }`}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise
        <img src={logo} alt="" width={28} height={28} className="h-6 w-6 object-contain sm:h-7 sm:w-7" />
      ) : (
        <Blocks className="h-6 w-6 text-accent" strokeWidth={1.75} />
      )}
      {ready && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />}
    </div>
  );
}

/** One ring of the hub, turning; each logo on it turns back so it stays upright. */
function Ring({ names, inset, seconds, turn }: { names: typeof CONNECTORS; inset: string; seconds: number; turn: number }) {
  return (
    <div className="orbit absolute" style={{ inset, "--orbit-for": `${seconds}s` } as React.CSSProperties}>
      {names.map((c, i) => (
        <div key={c.name} className="absolute -translate-x-1/2 -translate-y-1/2" style={onRing(i, names.length, turn)}>
          <div className="orbit-back">
            <Planet name={c.name} ready={c.ready} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Warmluke in the middle and what it connects to going round it: what
 * the app itself connects on the inner ring, what the team sets up on
 * the dashed outer one. A picture of the list beside it, so hidden from
 * a screen reader, which reads the list.
 */
function Hub() {
  return (
    <div aria-hidden="true" className="relative mx-auto aspect-square w-full max-w-[20rem] sm:max-w-[24rem]">
      <div className="absolute inset-[7%] rounded-full border border-dashed border-neutral-300" />
      <div className="absolute inset-[28%] rounded-full border border-hair bg-white/60" />
      <Ring names={CONNECTORS.filter((c) => !c.ready)} inset="7%" seconds={120} turn={45} />
      <Ring names={CONNECTORS.filter((c) => c.ready)} inset="28%" seconds={80} turn={-90} />
      <div className="absolute top-1/2 left-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-3xl border border-hair bg-white shadow-[0_2px_12px_-2px_rgb(0_0_0/0.12)]">
        <Logo className="h-8" />
      </div>
    </div>
  );
}

/**
 * Claude or ChatGPT, through MCP, into Warmluke: two curved paths meeting
 * at Warmluke, with light running along each (an animated beam). The
 * paths are one SVG and the tiles sit on it by the same coordinates, so
 * a line always ends at the middle of its tile, at any width.
 */
const BRIDGE = { w: 480, h: 200, from: [{ name: "Claude", src: "/logos/claude.svg", x: 70, y: 52 }, { name: "ChatGPT", src: "/logos/openai.svg", x: 70, y: 148 }], to: { x: 404, y: 100 } };

function Bridge() {
  const { w, h, from, to } = BRIDGE;
  const at = (x: number, y: number) => ({ left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%` });
  const path = (x: number, y: number) => `M${x} ${y} C ${x + 150} ${y}, ${to.x - 170} ${to.y}, ${to.x} ${to.y}`;
  return (
    <div aria-hidden="true" className="rounded-2xl border border-hair bg-neutral-50 p-3">
      <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
        <svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 h-full w-full" fill="none">
          <defs>
            <linearGradient id="bridge-light" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={w} y2="0">
              <stop offset="0" style={{ stopColor: "var(--color-luke-light)" }} />
              <stop offset="1" style={{ stopColor: "var(--color-luke)" }} />
            </linearGradient>
          </defs>
          {from.map((f, i) => (
            <g key={f.name}>
              <path d={path(f.x, f.y)} strokeWidth="2" style={{ stroke: "rgb(0 0 0 / 0.1)" }} />
              <path
                d={path(f.x, f.y)}
                pathLength={100}
                strokeWidth="3"
                strokeLinecap="round"
                stroke="url(#bridge-light)"
                className="beam-run"
                style={{ animationDelay: `${i * 1.4}s` }}
              />
            </g>
          ))}
        </svg>

        {from.map((f) => (
          <div key={f.name} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1" style={at(f.x, f.y)}>
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hair bg-white shadow-[0_6px_20px_-8px_rgb(0_0_0/0.25)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise */}
              <img src={f.src} alt="" width={20} height={20} className="h-5 w-5 object-contain" />
            </span>
          </div>
        ))}
        {from.map((f) => (
          <span
            key={`${f.name}-name`}
            className="absolute -translate-y-1/2 text-[11px] font-medium text-quiet"
            style={{ left: `${((f.x + 30) / w) * 100}%`, top: `${((f.y + (f.y < to.y ? -16 : 16)) / h) * 100}%` }}
          >
            {f.name}
          </span>
        ))}

        <span
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-luke-light/60 bg-white px-2 py-0.5 text-[10px] font-semibold tracking-widest text-luke"
          style={at(to.x - 170, to.y)}
        >
          MCP
        </span>

        <div className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center" style={at(to.x, to.y)}>
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-hair bg-white shadow-[0_2px_12px_-2px_rgb(0_0_0/0.12)]">
            <Logo className="h-7" />
          </span>
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
  const toolRoll = cycleCss(TOOLS.length, 2.2, "wl-tool");

  return (
    // overflow-x-clip: the globe and the hub are allowed to bleed past
    // the edge of their column, and never to make the page scroll sideways.
    <div id="top" className="font-ui overflow-x-clip bg-white text-ink">
      <LandingTracker variant={shown.id} />
      <FloatingNav cta={shown.cta} />
      {/* Built from the list rather than written out, so the timing
          stays right whatever length it grows to. Inline styles are
          what the policy allows; inline scripts are the thing this
          page deliberately does without. */}
      {roll && <style dangerouslySetInnerHTML={{ __html: roll }} />}
      {toolRoll && <style dangerouslySetInnerHTML={{ __html: toolRoll }} />}

      {/* ── The first screen, and the app under it ──────────── */}
      {/* At least one viewport, not exactly one: the glimpse of the app
          under the headline is something to click through, and a hero
          cut to the window height sliced it off wherever the fold fell. */}
      <div className="relative flex min-h-screen flex-col overflow-hidden">
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
          {/* The film gives way to the page at the bottom rather than
              stopping at an edge, and the glimpse of the app fades into
              the same white. */}
          <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-white" />
        </div>

        {/* gap-3 rather than justify-between alone: at 375px with the
            longest call to action ("Book a Demo") the wordmark and
            "Sign in" met in the middle with nothing between them.
            The gap is what stops them touching whatever the variant
            puts in the button; the smaller type below is what keeps
            the gap from eating the button. */}
        <header className="relative z-10 flex items-center justify-between gap-3 px-5 py-5 sm:px-6 md:px-12 lg:px-20">
          <div className="flex shrink-0 items-center gap-2">
            {/* The logo file as it is, with no tile of ours behind it;
                sized and given dimensions so the navbar does not
                jump while it loads. */}
            <Logo className="h-5" priority />
            <span className="text-lg font-semibold tracking-tight sm:text-xl">Warmluke</span>
          </div>
          <nav className="flex items-center gap-4 text-sm md:gap-6">
            <NavLinks />
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
            className="rise mb-6 flex max-w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 rounded-full border border-hair bg-white/80 py-1 pr-3 pl-1 text-xs text-quiet shadow-[0_1px_2px_rgb(0_0_0/0.04)] backdrop-blur"
            style={{ "--rise-from": "10px", "--rise-for": "0.5s" } as React.CSSProperties}
          >
            {HERO_CONNECTORS.filter((c) => c.ready).map((c) => (
              <span
                key={c.name}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise */}
                <img src={c.logo} alt="" width={12} height={12} className="h-3 w-3 object-contain" />
                {c.name} connected
              </span>
            ))}
            <span className="flex items-center gap-2">
              {HERO_CONNECTORS.filter((c) => !c.ready).map((c) => (
                // Not decoration: each logo carries its own data-cta,
                // which the tracker stores verbatim, so after a month
                // the clicks say which service merchants ask for.
                <a
                  key={c.name}
                  href="#book"
                  data-cta={`connector_${c.name.toLowerCase().replace(/\s+/g, "_")}`}
                  title={`Need ${c.name}? Our team sets it up. Book a demo and tell us.`}
                  aria-label={`${c.name}, set up by our team`}
                  className="opacity-80 transition-opacity hover:opacity-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise */}
                  <img src={c.logo} alt="" width={14} height={14} className="h-3.5 w-3.5 object-contain" />
                </a>
              ))}
            </span>
            {/* No number: a count invites "which twenty?". */}
            <a href="#integrations" data-cta="connectors_more" className="whitespace-nowrap transition-colors hover:text-ink">
              <span className="sm:hidden">with our team</span>
              <span className="hidden sm:inline">and more, set up by our team</span>
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
            className="rise mt-auto w-full max-w-6xl pt-8"
            style={{ "--rise-from": "30px", "--rise-for": "0.8s", "--rise-after": "0.5s" } as React.CSSProperties}
          >
            <StorePreview />
          </div>
        </main>
      </div>

      {/* ── Luke doing real work ─────────────────────────────── */}
      <Section id="luke" title="Ask Luke like you'd ask someone on your team.">
        {/* How fresh the store is, said per request: the same clock as the glimpse above. */}
        <AskLuke
          asks={ASKS.map((a) => (a.from[0] === "Shopify" ? { ...a, from: [...a.from, `synced ${ago(lastSync(Date.now()), Date.now())}`] } : a))}
          after={<Cta where="asks">See what Luke could do for your store →</Cta>}
        />
      </Section>

      {/* ── Proactive ────────────────────────────────────────── */}
      <Section title="Luke doesn't have to wait for you to ask.">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div>
            <p className="max-w-xl text-quiet">
              Traditional dashboards are useful only when somebody remembers to check them. Luke can
              help monitor the business continuously and surface important changes.
            </p>
            <p className="font-serif mt-8 text-2xl text-ink sm:text-3xl">
              Less checking dashboards. More knowing what needs your attention.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-hair bg-white shadow-[var(--shadow-dashboard)]">
            <div className="flex items-center justify-between border-b border-hair px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                <Bell aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
                What Luke noticed
              </span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-white">
                {WATCHES.length} new
              </span>
            </div>
            <ul className="divide-y divide-hair">
              {WATCHES.map((w) => {
                const Icon = w.icon;
                return (
                  <li key={w.area} className="flex items-start gap-3 px-4 py-3.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
                      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-ink">
                        {w.area}
                        {w.team && <span className="font-normal text-neutral-400">· with our team</span>}
                      </div>
                      <p className="mt-0.5 text-sm text-neutral-700">{w.what}</p>
                    </div>
                    <span className="shrink-0 text-[11px] whitespace-nowrap text-neutral-400">{w.when}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── Stop adding another app ──────────────────────────── */}
      <Section id="uses" eyebrow="Instead of buying another app" title="Stop adding another app.">
        <p className="max-w-2xl text-quiet">
          Your business will eventually need something your current software doesn&apos;t do.
          Usually that means searching the app store, trying three SaaS products, paying another
          subscription, and changing your workflow around the software.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-hair bg-neutral-50 p-6">
            <div className="text-sm font-medium text-neutral-500">The usual way</div>
            <ul className="mt-4 space-y-2">
              {USUAL.map((u) => (
                <li
                  key={u}
                  className="flex items-center justify-between gap-3 rounded-xl border border-hair bg-white px-4 py-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2.5 text-neutral-500">
                    <CreditCard aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                    <span className="truncate">{u}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">another subscription</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-quiet">
              Another login and another bill for each, and a workflow bent around every one.
            </p>
          </div>
          <div className="flex flex-col rounded-2xl border border-accent/30 bg-white p-6 shadow-[var(--shadow-dashboard)]">
            <div className="text-sm font-medium text-accent">With Luke</div>
            <p className="font-serif mt-3 text-2xl text-ink">Need something? Tell Luke.</p>
            <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-hair bg-neutral-50 px-4 py-3.5 text-sm text-ink">
              <Sparkles aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} />
              <span className="min-w-0">
                Build us{" "}
                {/* The first name is the real text; the rest take turns
                    over it, as the hero's names do. See cycleCss. */}
                <span className="font-medium text-accent">
                  {TOOLS.map((t, n) => (
                    <span
                      key={t}
                      aria-hidden={n > 0 ? "true" : undefined}
                      className="wl-tool"
                      style={{ animationDelay: `${(n * 2.2).toFixed(2)}s` }}
                    >
                      {withArticle(t)}
                    </span>
                  ))}
                </span>
                <span aria-hidden="true" className="caret ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-ink" />
              </span>
            </div>
            <p className="mt-5 text-sm text-quiet">
              Built into your app, shaped around how you already work, and only once you say yes.
            </p>
            <p className="font-serif mt-6 border-t border-hair pt-5 text-xl leading-snug text-ink lg:mt-auto">
              Your business shouldn&apos;t have to change how it works because another SaaS product
              was designed for everyone.
            </p>
          </div>
        </div>
      </Section>

      {/* ── One context ──────────────────────────────────────── */}
      <Section id="integrations" title="Your whole ecommerce business. One context.">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <p className="max-w-xl text-quiet">
              Your business already has the data. The problem is that it&apos;s spread across different
              systems. Warmluke brings that context together so Luke can understand the whole picture,
              not one dashboard at a time.
            </p>
            <dl className="mt-8 space-y-6">
              {[
                { ready: true, head: "Connected in the app" },
                { ready: false, head: "Set up by our team" },
              ].map((g) => (
                <div key={g.head}>
                  <dt
                    className={`flex items-center gap-2 text-sm font-medium ${
                      g.ready ? "text-emerald-700" : "text-neutral-500"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={
                        g.ready
                          ? "h-2 w-2 rounded-full bg-emerald-500"
                          : "h-2.5 w-2.5 rounded-full border border-dashed border-neutral-400"
                      }
                    />
                    {g.head}
                  </dt>
                  <dd className="mt-1.5 text-ink">
                    {CONNECTORS.filter((c) => c.ready === g.ready)
                      .map((c) => c.name)
                      .join(", ")}
                  </dd>
                  {!g.ready && (
                    <dd className="mt-2 max-w-md text-sm text-quiet">
                      Our team connects your ad accounts and WhatsApp, and sets up the reporting
                      against your orders.
                    </dd>
                  )}
                </div>
              ))}
            </dl>
            <p className="mt-6 text-sm text-neutral-400">
              Whatever a growing business runs on: payments, shipping, accounting, marketplaces, the
              spreadsheet your team actually lives in.{" "}
              <a href="#book" data-cta="connectors_ask" className="text-accent underline underline-offset-2 hover:opacity-80">
                Tell us yours on the demo
              </a>
              .
            </p>
          </div>
          <Hub />
        </div>
      </Section>

      {/* ── Bring your own assistant ─────────────────────────── */}
      <Section
        id="mcp"
        eyebrow="Claude or ChatGPT, connected"
        title="Bring your own AI. Give it the keys to your business."
      >
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <p className="max-w-xl text-quiet">
            Warmluke speaks MCP, the standard Claude and ChatGPT use to reach outside tools. Connect
            it once and the assistant you already pay for stops guessing about your business, and
            starts building inside it.
          </p>
          <Bridge />
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {BYO.map((g) => {
            const Icon = g.icon;
            return (
              <div key={g.head} className="rounded-2xl border border-hair bg-white p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </span>
                <div className="font-serif mt-4 text-lg text-ink">{g.head}</div>
                <p className="mt-2 text-sm leading-relaxed text-quiet">{g.body}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-8 rounded-2xl border border-hair bg-neutral-50 p-6">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-600" strokeWidth={1.75} />
            And what it cannot do
          </div>
          <div className="mt-5 grid gap-6 sm:grid-cols-3">
            {BYO_LIMITS.map(([head, body, Icon]) => (
              <div key={head}>
                <div className="flex items-center gap-2 text-sm font-medium text-ink">
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" strokeWidth={1.75} />
                  {head}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-quiet">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8">
          <Cta where="mcp">Connect your own AI →</Cta>
        </div>
      </Section>

      {/* ── Book ─────────────────────────────────────────────── */}
      <section id="book" className="border-t border-hair">
        <div className="reveal mx-auto w-full max-w-5xl px-5 py-16 sm:py-20">
          <div className="grid gap-8 rounded-3xl border border-hair bg-gradient-to-br from-indigo-50/70 via-white to-white p-6 sm:p-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-12">
            <div>
              <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-[2.75rem]">
                What would you ask Luke to fix first?
              </h2>
              <p className="mt-4 text-quiet">
                Connect your ecommerce business to Warmluke and see what Luke could do for your team.
                No generic sales pitch. Show us how your business works today and we&apos;ll show you
                what Warmluke can do with it.
              </p>
              <ul className="mt-6 space-y-2.5">
                {BOOK_POINTS.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-sm text-neutral-700">
                    <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2} />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="self-center rounded-2xl border border-hair bg-white p-5 shadow-[var(--shadow-dashboard)] sm:p-6">
              <DemoForm variant={shown.id} />
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      {/* The name large and fading behind everything, and the mark on a
          line across the bottom. Only real places are linked: no social
          accounts are listed until there are ones to list. Clipped rather
          than overflow-hidden: hidden makes the footer a scroll container,
          and the pop-ups would time themselves to it instead of the page. */}
      <footer className="relative overflow-clip border-t border-hair bg-white">
        <div className="relative mx-auto flex min-h-[30rem] w-full max-w-5xl flex-col justify-between px-5 pt-16 pb-10 sm:min-h-[34rem] md:min-h-[38rem]">
          <div className="reveal flex flex-col items-center text-center">
            <span className="text-3xl font-bold tracking-tight text-ink">Warmluke</span>
            <p className="mt-2 max-w-md text-sm font-medium text-balance text-quiet">
              One intelligent operating layer for your ecommerce business.
            </p>
            <nav aria-label="Footer" className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm font-medium text-quiet">
              {FOOTER_LINKS.map(([label, href]) => (
                <Link
                  key={href}
                  href={href}
                  data-cta={`footer_${label.toLowerCase().replace(/\s+/g, "_")}`}
                  className="transition-colors duration-200 hover:text-ink"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <p className="relative z-10 text-center text-sm text-quiet md:text-left">
            © {new Date().getFullYear()} Warmluke. All rights reserved.
          </p>
        </div>

        <div
          aria-hidden="true"
          className="reveal-pop pointer-events-none absolute bottom-40 left-1/2 -translate-x-1/2 select-none [--pop-scale:0.94] bg-gradient-to-b from-ink/20 via-ink/10 to-transparent bg-clip-text px-4 text-center leading-none font-extrabold tracking-tighter text-transparent md:bottom-32"
          style={{ fontSize: "clamp(3rem, 14vw, 11rem)", maxWidth: "95vw" }}
        >
          WARMLUKE
        </div>
        <div aria-hidden="true" className="absolute bottom-32 left-0 h-px w-full bg-gradient-to-r from-transparent via-neutral-300 to-transparent" />
        {/* Pressed, it gives and tilts; let go, it springs back past where
            it was. Only that: a link would jump the page away before the
            spring could be seen, and the way back up is the nav's. */}
        <div
          aria-hidden="true"
          className="group reveal-pop absolute bottom-24 left-1/2 z-10 -translate-x-1/2 [--pop-scale:0.6] rounded-3xl border border-hair bg-white/60 p-2.5 shadow-[0_10px_40px_-12px_rgb(0_0_0/0.35)] backdrop-blur-sm transition-[scale,translate,border-color] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:border-neutral-300 active:scale-90 active:duration-100 md:bottom-20"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-hair bg-white shadow-[0_2px_12px_-2px_rgb(0_0_0/0.12)] transition-[rotate] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-active:-rotate-12 group-active:duration-100 sm:h-16 sm:w-16 md:h-20 md:w-20">
            <Logo className="h-6 sm:h-7 md:h-9" />
          </span>
        </div>
      </footer>
    </div>
  );
}
