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
// Callers: none — this is "/".
// ─────────────────────────────────────────────────────────────

import Link from "next/link";
import { cookies } from "next/headers";
import { DEFAULT_HERO, VARIANT_COOKIE, heroById, resolveHero } from "@/lib/landing";
import { DemoForm, LandingTracker } from "@/components/Landing";

export const metadata = {
  title: "Warmluke — one place for your ecommerce business",
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
      data-cta={where}
      className={
        tone === "solid"
          ? "inline-flex rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          : "inline-flex rounded-xl border border-slate-700 px-6 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
      }
    >
      {children}
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
    <section id={id} className="border-t border-slate-900">
      <div className="mx-auto w-full max-w-5xl px-5 py-16 sm:py-20">
        {eyebrow && (
          <div className="mb-3 text-xs font-semibold tracking-widest text-blue-400">{eyebrow}</div>
        )}
        <h2 className="font-display text-2xl font-bold leading-tight tracking-tight sm:text-4xl">
          {title}
        </h2>
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}

const ASKS = [
  {
    q: "Why were sales down yesterday?",
    a: "Luke checks your store and marketing performance together and helps identify what changed.",
  },
  {
    q: "Tell me if we're wasting money on any ads.",
    a: "Luke can monitor your marketing data and surface issues your team should investigate.",
  },
  {
    q: "Which products are selling but about to run out?",
    a: "Luke combines store performance with inventory context and surfaces what needs attention.",
  },
  {
    q: "Our returns process is a mess. Make something better.",
    a: "Luke can create the workflow or internal tool your team needs.",
  },
  {
    q: "What are customers complaining about this week?",
    a: "Luke can analyse support conversations and help identify recurring issues.",
  },
  {
    q: "Create a dashboard for my operations team.",
    a: "Luke can generate tools around the way your business actually works.",
  },
];

const WATCHES: Array<[string, string]> = [
  ["Marketing", "A campaign suddenly starts spending without converting."],
  ["Operations", "Orders haven't been dispatched within the expected time."],
  ["Inventory", "A fast-moving product is approaching low stock."],
  ["Support", "The same customer complaint starts appearing repeatedly."],
  ["Performance", "Conversion rate changes significantly."],
  ["Returns", "Returns suddenly increase for a particular product."],
];

const AREAS = [
  {
    name: "Operations",
    items: ["Orders", "Inventory", "Returns", "Shipping", "Workflows", "Internal dashboards"],
    body: "Connect the operational parts of your store and give your team one place to understand what's happening and get things done.",
  },
  {
    name: "Marketing",
    items: ["Meta Ads", "Google Ads", "Store performance", "Campaign monitoring", "Reporting"],
    body: "Luke can look beyond individual advertising dashboards and understand marketing performance in the context of the actual business.",
  },
  {
    name: "Support",
    items: ["WhatsApp", "Customer conversations", "Reviews", "Common issues", "Support workflows"],
    body: "Bring customer conversations closer to the rest of the business so recurring problems don't stay buried inside support tickets.",
  },
];

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

  // Middleware has already decided and written the cookie; reading the
  // parameters again here keeps the two in step on the first request,
  // when the cookie it just set is not yet on the way back in.
  const jar = await cookies();
  const { hero } = resolveHero({
    wlVariant: one("wl_variant"),
    utmCampaign: one("utm_campaign"),
    assigned: jar.get(VARIANT_COOKIE)?.value,
  });
  // Belt and braces: a malformed everything still renders a headline.
  const shown = hero ?? heroById(DEFAULT_HERO)!;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <LandingTracker variant={shown.id} />

      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
            W
          </div>
          <span className="font-display text-base font-semibold tracking-tight">Warmluke</span>
        </div>
        <nav className="flex items-center gap-5 text-sm">
          <a href="#luke" className="hidden text-slate-400 transition-colors hover:text-white sm:inline">
            Luke
          </a>
          <a href="#uses" className="hidden text-slate-400 transition-colors hover:text-white sm:inline">
            Use Cases
          </a>
          <a
            href="#integrations"
            className="hidden text-slate-400 transition-colors hover:text-white sm:inline"
          >
            Integrations
          </a>
          <Link href="/login" className="text-slate-400 transition-colors hover:text-white">
            Sign in
          </Link>
          <a
            href="#book"
            data-cta="nav"
            className="rounded-lg bg-white px-4 py-2 font-medium text-slate-900 transition-colors hover:bg-slate-200"
          >
            Book a Demo
          </a>
        </nav>
      </header>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-4xl px-5 pb-16 pt-10 text-center sm:pt-16">
        {shown.eyebrow && (
          <div className="mb-4 inline-flex rounded-full border border-slate-800 bg-slate-900 px-4 py-1.5 text-xs font-semibold tracking-widest text-slate-300">
            {shown.eyebrow}
          </div>
        )}
        <h1 className="font-display text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl">
          {shown.headline}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-400 sm:text-lg">
          {shown.sub}
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Cta where="hero">{shown.cta}</Cta>
          {shown.secondary && (
            <Cta where="hero_secondary" tone="quiet">
              {shown.secondary}
            </Cta>
          )}
        </div>

        {shown.supporting && (
          <p className="mt-6 text-xs tracking-wide text-slate-500">{shown.supporting}</p>
        )}

        {/* What the product actually does, rather than an illustration
            of an idea. */}
        <div className="mt-14 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 text-left shadow-2xl shadow-blue-500/5">
          <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="ml-2 text-xs text-slate-500">Warmluke — Luke</span>
          </div>
          <div className="space-y-4 p-5 sm:p-7">
            <div className="ml-auto max-w-md rounded-2xl rounded-br-sm bg-blue-500/15 px-4 py-3 text-sm text-slate-100">
              Why were sales down yesterday?
            </div>
            <div className="max-w-xl rounded-2xl rounded-bl-sm border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-300">
              <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                <span className="rounded border border-slate-800 px-1.5 py-0.5">Shopify</span>
                <span className="rounded border border-slate-800 px-1.5 py-0.5">Meta</span>
                <span className="rounded border border-slate-800 px-1.5 py-0.5">Google</span>
              </div>
              Orders fell 24% against last Tuesday. Sessions held steady, so it isn&apos;t traffic —
              two of your best-selling variants went out of stock at 11:40, and the campaign driving
              them kept spending for another six hours.
            </div>
          </div>
        </div>
      </main>

      {/* ── One context ──────────────────────────────────────── */}
      <Section id="integrations" title="Your whole ecommerce business. One context.">
        <div className="flex flex-wrap gap-2">
          {[
            "Shopify",
            "Meta",
            "Google",
            "WhatsApp",
            "Customer Support",
            "Logistics",
            "Reviews",
            "Internal Tools",
            "Custom Apps",
          ].map((n) => (
            <span
              key={n}
              className="rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2 text-sm text-slate-300"
            >
              {n}
            </span>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-slate-400">
          Your business already has the data. The problem is that it&apos;s spread across different
          systems. Warmluke brings that context together so Luke can understand the whole picture —
          not one dashboard at a time.
        </p>
      </Section>

      {/* ── Luke doing real work ─────────────────────────────── */}
      <Section id="luke" title="Ask Luke like you'd ask someone on your team.">
        <div className="grid gap-4 sm:grid-cols-2">
          {ASKS.map((x) => (
            <div key={x.q} className="rounded-2xl border border-slate-900 bg-slate-900/50 p-5">
              <div className="font-display text-base font-semibold text-slate-100">
                &ldquo;{x.q}&rdquo;
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{x.a}</p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Cta where="asks">See what Luke could do for your store →</Cta>
        </div>
      </Section>

      {/* ── Proactive ────────────────────────────────────────── */}
      <Section title="Luke doesn't have to wait for you to ask.">
        <p className="max-w-2xl text-slate-400">
          Traditional dashboards are useful only when somebody remembers to check them. Luke can
          help monitor the business continuously and surface important changes.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {WATCHES.map(([area, what]) => (
            <div key={area} className="rounded-xl border border-slate-900 bg-slate-900/50 p-4">
              <div className="text-xs font-semibold tracking-widest text-blue-400">
                {area.toUpperCase()}
              </div>
              <p className="mt-1.5 text-sm text-slate-300">{what}</p>
            </div>
          ))}
        </div>
        <p className="font-display mt-8 text-xl font-semibold text-slate-100 sm:text-2xl">
          Less checking dashboards. More knowing what needs your attention.
        </p>
      </Section>

      {/* ── Stop adding another app ──────────────────────────── */}
      <Section id="uses" eyebrow="INSTEAD OF BUYING ANOTHER APP" title="Stop adding another app.">
        <p className="max-w-2xl text-slate-400">
          Your business will eventually need something your current software doesn&apos;t do.
          Usually that means searching the app store, trying three SaaS products, paying another
          subscription, and changing your workflow around the software.
        </p>
        <p className="font-display mt-6 text-xl font-semibold text-slate-100">
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
              className="rounded-full border border-slate-800 px-3.5 py-1.5 text-xs text-slate-400"
            >
              {n}
            </span>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-slate-400">
          Your business shouldn&apos;t have to change how it works because another SaaS product was
          designed for everyone.
        </p>
      </Section>

      {/* ── Three areas ──────────────────────────────────────── */}
      <Section title="One Luke. Across your business.">
        <div className="grid gap-5 sm:grid-cols-3">
          {AREAS.map((a) => (
            <div key={a.name} className="rounded-2xl border border-slate-900 bg-slate-900/50 p-5">
              <div className="font-display text-lg font-semibold">{a.name}</div>
              <ul className="mt-3 space-y-1 text-sm text-slate-400">
                {a.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-slate-400">{a.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Against a general-purpose assistant ──────────────── */}
      <Section title="AI is more useful when it actually knows your business.">
        <p className="max-w-2xl text-slate-400">
          ChatGPT and Claude are great general-purpose AI tools. But unless you repeatedly give them
          your store data, advertising data, support context and operational information, they
          don&apos;t know what&apos;s happening inside your business. Luke does.
        </p>
        <p className="mt-5 max-w-2xl text-slate-400">
          Prefer ChatGPT or Claude? Warmluke can connect to them too, so you can reach your business
          context from the AI tools you already use.
        </p>
        <p className="font-display mt-8 text-xl font-semibold text-slate-100 sm:text-2xl">
          Stop explaining your business to AI every time you start a conversation.
        </p>
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
            <div key={t} className="rounded-2xl border border-slate-900 bg-slate-900/50 p-5">
              <div className="font-display text-base font-semibold">{t}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{b}</p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Cta where="how" />
        </div>
      </Section>

      {/* ── Book ─────────────────────────────────────────────── */}
      <section id="book" className="border-t border-slate-900">
        <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
          <h2 className="font-display text-2xl font-bold leading-tight tracking-tight sm:text-4xl">
            What would you ask Luke to fix first?
          </h2>
          <p className="mt-4 text-slate-400">
            Connect your ecommerce business to Warmluke and see what Luke could do for your team. No
            generic sales pitch — show us how your business works today and we&apos;ll show you what
            Warmluke can do with it.
          </p>
          <div className="mt-8">
            <DemoForm variant={shown.id} />
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-900 py-8">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-5 text-xs text-slate-500">
          <span>Warmluke — one intelligent operating layer for your ecommerce business.</span>
          <span className="flex gap-4">
            <Link href="/privacy" className="hover:text-slate-300">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-slate-300">
              Terms
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
