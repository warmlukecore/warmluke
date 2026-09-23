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
  /**
   * The words of the headline set in serif italic.
   *
   * Must appear in the headline verbatim; check-landing refuses a
   * variant where it does not, because a mismatch is invisible —
   * the line still renders, just flat, and nobody notices that the
   * design lost its one piece of typography.
   */
  emphasis?: string;
  /**
   * One word of the headline that cycles through a list.
   *
   * `word` must appear in the headline verbatim, the same rule
   * emphasis follows and for the same reason: a mismatch renders a
   * perfectly good static line and nobody notices the animation
   * never arrived. check-landing refuses it.
   *
   * The list is marketing surface, not a compatibility claim. Which
   * assistants can really connect is stated plainly in the page's
   * own MCP section, where somebody deciding will look.
   */
  cycle?: { word: string; through: readonly string[] };
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
    weight: 30,
    live: true,
    headline: "Meet Luke. The AI that helps run your ecommerce business.",
    emphasis: "run",
    sub: "Connect your store, marketing, support and operations to Warmluke. Luke understands what's happening, helps you take action and builds the tools your business needs.",
    cta: "Book a Demo",
    secondary: "See how it works",
    // Only what is connected today. Listing Meta, Google and WhatsApp
    // here read as "these are plugged in", and none of them is.
    supporting: "Connected today: Shopify. Orders, products, customers, stock.",
  },
  {
    id: "apps",
    weight: 30,
    live: true,
    eyebrow: "STOP ADDING SOFTWARE.",
    headline: "Your ecommerce business doesn't need another app.",
    emphasis: "another app",
    sub: "Warmluke brings your store, marketing, support and operations together. When you need something new, tell Luke instead of adding another SaaS subscription.",
    cta: "Book a Demo",
  },
  {
    // Ten, not twenty-five.
    //
    // Reaching your data from ChatGPT or Claude is a feature of
    // this product, not what it is for, and a hero that leads with
    // it sells the feature. It stays in the test because the angle
    // is worth measuring; it stops being a quarter of everybody's
    // first impression.
    id: "chatgpt",
    weight: 10,
    live: true,
    headline: "You've got ChatGPT. Now give your business its own AI.",
    emphasis: "its own AI",
    // Names of a similar length on purpose. They are stacked in one
    // grid cell so the words around them never jump, which means the
    // cell is as wide as the longest — and one long name leaves a
    // visible gap before the full stop on every other. "Perplexity"
    // was three characters too many.
    // The full stop travels with the name, and only one name holds
    // space at a time. Both matter: these run from four letters to
    // seven, and a cell wide enough for the longest leaves the
    // shorter ones adrift from their own punctuation.
    cycle: {
      word: "ChatGPT.",
      through: ["ChatGPT.", "Claude.", "Gemini.", "Qwen.", "Mimo."],
    },
    // Reads straight on from "its own AI", and says what that is
    // before it says how you reach it. The old line was entirely
    // about the connection, which made a feature sound like the
    // whole product to whoever landed on this variant.
    sub: "One that already knows your orders, stock and customers, answers from them, spots problems before you do, and builds the tools your team needs. You can reach it from ChatGPT or Claude too.",
    cta: "Meet Luke",
    secondary: "Book a Demo",
  },
  {
    id: "problem",
    weight: 30,
    live: true,
    headline: "Have a problem with your ecommerce business? Tell Luke.",
    emphasis: "Tell Luke",
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
    emphasis: "one place",
    sub: "Warmluke connects the systems your team already uses. Luke sits across them, understands your business and helps you get work done.",
    cta: "Book a Demo",
  },
  {
    id: "saas",
    weight: 0,
    live: false,
    headline: "Stop buying another app every time your store has a problem.",
    emphasis: "every time",
    sub: "Connect your ecommerce business to Warmluke and ask Luke to analyse, automate or build what you need.",
    cta: "Book a Demo",
  },
  {
    id: "proactive",
    weight: 0,
    live: false,
    headline: "Your business shouldn't wait for you to ask what's wrong.",
    emphasis: "wait for you",
    sub: "Luke understands what's happening across your ecommerce business and helps surface the things your team might otherwise miss.",
    cta: "Book a Demo",
  },
  {
    id: "custom",
    weight: 0,
    live: false,
    headline: "Your ecommerce business isn't generic. Your software shouldn't be either.",
    emphasis: "isn't generic",
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

/** One piece of a headline, and how it is meant to be drawn. */
export type HeadlinePart = { text: string; kind: "plain" | "italic" | "cycle" };

/**
 * A headline cut into ordered pieces.
 *
 * Two words can be marked — one set in serif italic, one that cycles
 * through a list — and they may appear in either order or not at
 * all. Cutting once and returning the pieces keeps that ordering
 * decision here rather than in the markup, where two overlapping
 * string searches would eventually disagree.
 *
 * The first occurrence only: a word that appears twice is marked
 * where a reader meets it. Anything unmatched comes back as plain
 * text, so a wrong marker costs the decoration and never a word.
 */
export function headlineParts(hero: Hero): HeadlinePart[] {
  const marks: Array<{ at: number; text: string; kind: "italic" | "cycle" }> = [];
  const mark = (want: string | undefined, kind: "italic" | "cycle") => {
    const word = want?.trim();
    if (!word) return;
    const at = hero.headline.indexOf(word);
    if (at >= 0) marks.push({ at, text: word, kind });
  };
  mark(hero.emphasis, "italic");
  mark(hero.cycle?.word, "cycle");
  marks.sort((a, b) => a.at - b.at);

  const parts: HeadlinePart[] = [];
  let cut = 0;
  for (const m of marks) {
    // Two markers that overlap would otherwise emit the second one
    // twice and lose the text between them.
    if (m.at < cut) continue;
    if (m.at > cut) parts.push({ text: hero.headline.slice(cut, m.at), kind: "plain" });
    parts.push({ text: m.text, kind: m.kind });
    cut = m.at + m.text.length;
  }
  if (cut < hero.headline.length) parts.push({ text: hero.headline.slice(cut), kind: "plain" });
  return parts;
}

/**
 * The CSS that rolls the cycling word, built for however many words
 * there are.
 *
 * Generated rather than written by hand because the percentages
 * depend on the count: with five words each is on screen for a fifth
 * of the loop, and a list that grows to six against keyframes still
 * cut for five shows one word twice and one never. Inline, which the
 * policy allows for styles, and server-rendered, so the animation is
 * running before any JavaScript has loaded.
 *
 * `name` is the class and the keyframes, so two rolls on one page each
 * keep their own timing.
 */
export function cycleCss(count: number, each = 2.2, name = "wl-cycle"): string | null {
  if (count < 2) return null;
  const hold = 100 / count;
  const fade = Math.min(hold * 0.24, 5);
  // A hair either side of a boundary, so the collapse reads as
  // instant rather than as the word shrinking.
  const snap = 0.001;
  const at = (pc: number) => Math.max(0, Math.min(100, pc)).toFixed(3);
  return [
    `@keyframes ${name} {`,
    // font-size, not display.
    //
    // Only the name being shown may take up space, or the line is
    // as wide as the longest and the full stop drifts away from
    // every shorter one. The obvious way to do that is to animate
    // display, and it does not work: an element that is display
    // none is not rendered, so the animation that would reveal it
    // never runs. Collapsing the type to nothing takes the width
    // away just as well and keeps the element alive.
    `  0% { font-size: 0; opacity: 0; transform: translateY(0.3em); }`,
    `  ${at(snap)}% { font-size: 1em; opacity: 0; }`,
    `  ${at(fade)}% { font-size: 1em; opacity: 1; transform: none; }`,
    `  ${at(hold - fade)}% { font-size: 1em; opacity: 1; transform: none; }`,
    `  ${at(hold)}% { font-size: 1em; opacity: 0; transform: translateY(-0.3em); }`,
    `  ${at(hold + snap)}% { font-size: 0; opacity: 0; }`,
    `  100% { font-size: 0; opacity: 0; }`,
    "}",
    // backwards fill, so a name waiting its turn is already
    // collapsed rather than sitting there at full width.
    `.${name} { animation: ${name} ${(count * each).toFixed(2)}s infinite both; }`,
    "@media (prefers-reduced-motion: reduce) {",
    // Still legible, still honest: the first name stays put.
    `  .${name} { animation: none; font-size: 0; opacity: 0; }`,
    `  .${name}:first-child { font-size: 1em; opacity: 1; }`,
    "}",
  ].join("\n");
}
