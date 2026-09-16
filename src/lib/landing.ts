// ─────────────────────────────────────────────────────────────
// The hero, and which one a visitor sees.
//
// The headline is not a decision anyone has made yet — it is several
// positioning angles waiting to be tested against each other. So the
// copy lives here as data rather than in the page, and adding or
// retiring one is an edit to this list, not a redesign.
//
// Four things can decide which hero to show, and they are tried in
// this order:
//
//   1. wl_variant in the URL. Explicit, so it always wins.
//   2. The campaign the click came from, mapped below.
//   3. What this visitor was already shown this session.
//   4. The running experiment, weighted.
//
// A malformed parameter never produces an empty hero — an unknown name
// simply is not a variant, and the next rule answers.
//
// Why wl_variant AND utm_campaign: campaign names get renamed for
// reasons that have nothing to do with this page. UTMs are attribution;
// wl_variant is presentation, and it does not move when marketing
// reorganises its naming.
//
// Callers: src/middleware.ts, src/app/page.tsx.
// ─────────────────────────────────────────────────────────────

export type Hero = {
  id: string;
  /** Out of 100, across the variants marked live. */
  weight: number;
  /** Whether the experiment may assign this one to organic traffic. */
  live: boolean;
  eyebrow?: string;
  headline: string;
  sub: string;
  cta: string;
  secondary?: string;
  supporting?: string;
};

/**
 * The first angles worth testing.
 *
 * These deliberately argue different things rather than reword one
 * sentence — the question is which positioning lands, not which verb.
 */
export const HEROES: Hero[] = [
  {
    id: "operator",
    weight: 25,
    live: true,
    headline: "Meet Luke. The AI that helps run your ecommerce business.",
    sub: "Connect your store, marketing, support and operations to Warmluke. Luke understands what's happening, helps you take action and builds the tools your business needs.",
    cta: "Book a Demo",
    secondary: "See how it works",
    // Only what is connected today. Listing Meta, Google and WhatsApp
    // here read as "these are plugged in", and none of them is.
    supporting: "Connected today: Shopify — orders, products, customers, stock",
  },
  {
    id: "apps",
    weight: 25,
    live: true,
    eyebrow: "STOP ADDING SOFTWARE.",
    headline: "Your ecommerce business doesn't need another app.",
    sub: "Warmluke brings your store, marketing, support and operations together. When you need something new, tell Luke instead of adding another SaaS subscription.",
    cta: "Book a Demo",
  },
  {
    id: "chatgpt",
    weight: 25,
    live: true,
    headline: "You've got ChatGPT. Now give your business its own AI.",
    sub: "Connect Warmluke to ChatGPT or Claude and ask about your real orders, customers and stock — so AI can finally answer from what's actually in your store.",
    cta: "Meet Luke",
    secondary: "Book a Demo",
  },
  {
    id: "problem",
    weight: 25,
    live: true,
    headline: "Have a problem with your ecommerce business? Tell Luke.",
    sub: "Ask about your orders, customers and stock. Automate repetitive work. Or have Luke build the internal tool your business needs and can't buy.",
    cta: "Book a Demo",
  },
  // Written and ready, but out of the running experiment: the first
  // test is four angles, not eight, or none of them sees enough
  // traffic to say anything.
  {
    id: "oneplace",
    weight: 0,
    live: false,
    headline: "Run your ecommerce business from one place.",
    sub: "Warmluke connects the systems your team already uses. Luke sits across them, understands your business and helps you get work done.",
    cta: "Book a Demo",
  },
  {
    id: "saas",
    weight: 0,
    live: false,
    headline: "Stop buying another app every time your store has a problem.",
    sub: "Connect your ecommerce business to Warmluke and ask Luke to analyse, automate or build what you need.",
    cta: "Book a Demo",
  },
  {
    id: "proactive",
    weight: 0,
    live: false,
    headline: "Your business shouldn't wait for you to ask what's wrong.",
    sub: "Luke understands what's happening across your ecommerce business and helps surface the things your team might otherwise miss.",
    cta: "Book a Demo",
  },
  {
    id: "custom",
    weight: 0,
    live: false,
    headline: "Your ecommerce business isn't generic. Your software shouldn't be either.",
    sub: "Warmluke adapts to how your business works. Ask Luke for the workflows, dashboards and tools your team actually needs.",
    cta: "Book a Demo",
  },
];

/** Until experiment data says otherwise. */
export const DEFAULT_HERO = "operator";

/**
 * Which hero an advertising campaign continues into.
 *
 * Someone who clicked an ad about paying for twelve apps should not
 * land on a headline about something else; the ad and the page are one
 * conversation.
 */
export const CAMPAIGN_HEROES: Record<string, string> = {
  replace_apps: "apps",
  saas_replacement: "apps",
  ai_operator: "operator",
  chatgpt: "chatgpt",
  custom_software: "custom",
};

export const VARIANT_COOKIE = "wl_variant";

export function heroById(id: string | null | undefined): Hero | null {
  if (!id) return null;
  return HEROES.find((h) => h.id === id) ?? null;
}

/** One of the live variants, by weight. */
export function assignHero(random = Math.random()): Hero {
  const live = HEROES.filter((h) => h.live && h.weight > 0);
  if (live.length === 0) return heroById(DEFAULT_HERO) ?? HEROES[0];

  const total = live.reduce((n, h) => n + h.weight, 0);
  let point = random * total;
  for (const h of live) {
    point -= h.weight;
    if (point < 0) return h;
  }
  return live[live.length - 1];
}

/**
 * The hero this request should show, and why.
 *
 * `assigned` is what the visitor was given earlier in the session. It
 * loses to an explicit wl_variant — advertising traffic says what it
 * wants — and wins over a fresh roll, so the page does not change
 * under somebody who reloads it.
 */
export function resolveHero(input: {
  wlVariant?: string | null;
  utmCampaign?: string | null;
  assigned?: string | null;
  random?: number;
}): { hero: Hero; source: "url" | "campaign" | "assigned" | "experiment" } {
  const explicit = heroById(input.wlVariant);
  if (explicit) return { hero: explicit, source: "url" };

  const byCampaign = heroById(
    input.utmCampaign ? CAMPAIGN_HEROES[input.utmCampaign.toLowerCase()] : null
  );
  if (byCampaign) return { hero: byCampaign, source: "campaign" };

  const remembered = heroById(input.assigned);
  if (remembered) return { hero: remembered, source: "assigned" };

  return { hero: assignHero(input.random), source: "experiment" };
}

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;
