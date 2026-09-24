"use client";

// ─────────────────────────────────────────────────────────────
// The things on the landing page that are not just words: the
// tracking, the demo form, and the questions a visitor can try on Luke.
//
// A hero test is only worth running if four questions can be answered
// afterwards: which hero was shown, which advertisement sent the
// person, did they click, and did they actually book. Click rate alone
// would reward the most aggressive headline rather than the one that
// brings a business worth talking to.
//
// Nothing here blocks the page. A visitor with tracking blocked, or no
// storage, still reads everything and can still book — the row simply
// does not get written.
//
// Callers: src/app/page.tsx.
// ─────────────────────────────────────────────────────────────

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  LayoutDashboard,
  Package,
  RotateCcw,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { OrdersGlobe } from "@/components/OrdersGlobe";
import { supabase } from "@/lib/supabase-client";
import { UTM_KEYS, type Utm } from "@/lib/landing";
import { bookDemo, type BookingState } from "@/app/actions";
import { Logo } from "@/components/ui/Logo";

const SESSION_KEY = "wl_session";

/** Stable per browser, so the four events join up into one story. */
function sessionId(): string {
  try {
    const had = localStorage.getItem(SESSION_KEY);
    if (had && had.length >= 8) return had;
    const made = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    localStorage.setItem(SESSION_KEY, made);
    return made;
  } catch {
    // Private window, or storage refused. One visit, one id.
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
}

/**
 * Where they are, short enough to store.
 *
 * The column caps this at 500, and a query string longer than that
 * would have failed the whole insert — including the booking, which is
 * the one event that must not be lost over a detail nobody reads.
 */
function landingPath(): string {
  try {
    return (window.location.pathname + window.location.search).slice(0, 500);
  } catch {
    return "/";
  }
}

/** The advertising parameters, kept whole rather than interpreted. */
function utmFromUrl(): Utm {
  const out: Utm = {};
  try {
    const q = new URLSearchParams(window.location.search);
    for (const k of UTM_KEYS) {
      const v = q.get(k);
      if (v) out[k] = v.slice(0, 200);
    }
  } catch {
    // Nothing to read is not an error.
  }
  return out;
}

async function record(
  event: "view" | "cta_click" | "demo_start" | "demo_booked",
  variant: string,
  payload: Record<string, unknown> = {}
) {
  try {
    await supabase.from("landing_events").insert({
      session_id: sessionId(),
      variant,
      ...utmFromUrl(),
      landing_path: landingPath(),
      event,
      payload,
    });
  } catch {
    // A page that failed to load because analytics failed would be a
    // worse page. The visit is lost, not the visitor.
  }
}

/**
 * Records the visit, and every click on something marked data-cta.
 *
 * One listener rather than a handler per button, so the page itself
 * stays server-rendered and a new CTA anywhere is tracked by carrying
 * the attribute rather than by somebody remembering to wire it up.
 */
export function LandingTracker({ variant }: { variant: string }) {
  useEffect(() => {
    void record("view", variant);

    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-cta]");
      if (!el) return;
      void record("cta_click", variant, {
        cta: el.getAttribute("data-cta") ?? "",
        label: (el.textContent ?? "").trim().slice(0, 80),
      });
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [variant]);

  return null;
}

/**
 * Asking for a demo.
 *
 * Deliberately short. Everything here gets asked again on the call, so
 * anything beyond who they are and where their store is only costs the
 * form its completion rate.
 */
export function DemoForm({ variant }: { variant: string }) {
  const [state, act, pending] = useActionState<BookingState, FormData>(bookDemo, {
    ok: false,
  });
  const started = useRef(false);
  // One key per rendered form. A submit whose answer never arrived and
  // is sent again carries the same one, so the lead lands once.
  const idem = useId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) + Date.now().toString(36);
  const [ctx, setCtx] = useState<{ session: string; path: string; utm: Utm }>({
    session: "",
    path: "",
    utm: {},
  });

  // Filled after mount, because none of it exists on the server. With
  // JavaScript off these stay empty and the action makes its own — the
  // booking still arrives, it just is not joined to the earlier events.
  useEffect(() => {
    setCtx({ session: sessionId(), path: landingPath(), utm: utmFromUrl() });
  }, []);

  function began() {
    if (started.current) return;
    started.current = true;
    void record("demo_start", variant);
  }

  if (state.ok) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <div className="font-serif text-xl text-emerald-800">
          Got it. We&apos;ll be in touch.
        </div>
        <p className="mt-2 text-sm text-quiet">
          We&apos;ll write to set up a time that suits you.
        </p>
      </div>
    );
  }

  return (
    <form action={act} onFocusCapture={began} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="variant" value={variant} />
      <input type="hidden" name="idem" value={idem} />
      <input type="hidden" name="session_id" value={ctx.session} />
      <input type="hidden" name="landing_path" value={ctx.path} />
      {UTM_KEYS.map((k) => (
        <input key={k} type="hidden" name={k} value={ctx.utm[k] ?? ""} />
      ))}

      <input
        name="name"
        required
        placeholder="Your name"
        className="rounded-xl border border-hair bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-neutral-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <input
        name="email"
        type="email"
        required
        placeholder="Work email"
        className="rounded-xl border border-hair bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-neutral-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <input
        name="store"
        required
        placeholder="Your store URL"
        className="rounded-xl border border-hair bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-neutral-400 focus:border-accent focus:ring-2 focus:ring-accent/20 sm:col-span-2"
      />
      <textarea
        name="note"
        rows={3}
        placeholder="What would you ask Luke to fix first?"
        className="resize-none rounded-xl border border-hair bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-neutral-400 focus:border-accent focus:ring-2 focus:ring-accent/20 sm:col-span-2"
      />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          data-cta="book"
          className="rounded-full bg-ink px-6 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "Sending\u2026" : "Book a Demo"}
        </button>
        {state.message && <span className="text-sm text-amber-700">{state.message}</span>}
      </div>
    </form>
  );
}

/** Which picture comes out of the chat with an answer. */
export type Show = "stock" | "orders" | "customer" | "returns" | "dashboard" | "rule";

/** One question Luke can be asked, and the answer it gives. */
export type Ask = {
  /** How the question is listed. */
  q: string;
  /** What Luke does with it, in a line. */
  a: string;
  /** What is typed into the chat, when that is put differently from the list. */
  said?: string;
  reply: string;
  /** Where the answer came from, shown above it. */
  from: string[];
  show: Show;
};

/** Each answer's icon in the list, by what it shows. Here and not in the data, because an icon cannot cross from the server. */
const ASK_ICON: Record<Show, LucideIcon> = {
  stock: Package,
  orders: CalendarDays,
  customer: UserRound,
  returns: RotateCcw,
  dashboard: LayoutDashboard,
  rule: ShieldCheck,
};

/**
 * What comes out of the chat beside an answer: the same facts, drawn.
 * The numbers are the ones the reply says, so the two never disagree.
 */
function Artifact({ show }: { show: Show }) {
  const card = "w-full max-w-[17rem] rounded-xl border border-hair bg-white p-3.5 shadow-[0_24px_48px_-20px_rgb(49_46_129/0.35)]";
  const head = "mb-2.5 flex items-center justify-between text-xs font-medium text-neutral-500";
  if (show === "stock") {
    const rows: Array<[string, number]> = [
      ["Classic Tee / M", 4],
      ["Canvas Tote", 7],
      ["Ceramic Mug / White", 9],
    ];
    return (
      <div className={card}>
        <div className={head}>
          Running low <Package aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="space-y-2.5">
          {rows.map(([name, n]) => (
            <div key={name}>
              <div className="flex justify-between gap-3 text-xs text-ink">
                <span className="truncate">{name}</span>
                <span className="shrink-0 tabular-nums">{n} left</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-neutral-100">
                <div className={`h-1.5 rounded-full ${n < 5 ? "bg-rose-400" : "bg-amber-400"}`} style={{ width: `${n * 10}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (show === "orders") {
    const week = [11, 14, 9, 16, 12, 15, 18];
    return (
      <div className={card}>
        <div className={head}>
          Last 7 days <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="flex h-16 items-end gap-1.5">
          {week.map((n, i) => (
            <div key={i} className={`flex-1 rounded-t ${i === week.length - 1 ? "bg-accent" : "bg-accent/25"}`} style={{ height: `${(n / 18) * 100}%` }} />
          ))}
        </div>
        <div className="mt-2.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="text-quiet">Yesterday</span>
          <span className="text-ink">
            <span className="font-serif text-lg">18</span> orders · $4,120
          </span>
        </div>
      </div>
    );
  }
  if (show === "customer") {
    return (
      <div className={card}>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">PS</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Priya Sharma</div>
            <div className="text-xs text-quiet">4 orders · $1,842 since March</div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-neutral-50 px-2.5 py-2 text-xs">
          <span className="text-ink">#1041 · $598</span>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">Awaiting payment</span>
        </div>
      </div>
    );
  }
  if (show === "returns") {
    const cols: Array<[string, number, string]> = [
      ["Requested", 3, "bg-neutral-300"],
      ["Received", 2, "bg-neutral-400"],
      ["Refunded", 1, "bg-accent"],
    ];
    return (
      <div className={card}>
        <div className={head}>
          Returns board <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {cols.map(([name, n, tone]) => (
            <div key={name} className="rounded-lg bg-neutral-50 p-1.5">
              <div className="truncate text-[10px] text-quiet">{name}</div>
              <div className="mt-1.5 space-y-1">
                {Array.from({ length: n }, (_, i) => (
                  <div key={i} className="rounded border border-hair bg-white p-1">
                    <div className={`h-1 w-2/3 rounded-full ${tone}`} />
                    <div className="mt-1 h-1 w-full rounded-full bg-neutral-100" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (show === "dashboard") {
    const tiles: Array<[string, string]> = [
      ["To send", "6"],
      ["Low stock", "3"],
      ["Returns", "2"],
    ];
    return (
      <div className={card}>
        <div className={head}>
          Operations <LayoutDashboard aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {tiles.map(([name, n]) => (
            <div key={name} className="rounded-lg bg-neutral-50 p-2">
              <div className="truncate text-[10px] text-quiet">{name}</div>
              <div className="font-serif text-2xl text-ink">{n}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 h-8 rounded-lg bg-gradient-to-r from-accent/15 to-accent/5" />
      </div>
    );
  }
  return (
    <div className={card}>
      <div className={head}>
        New rule <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="rounded-lg bg-neutral-50 px-2 py-1.5 text-ink">Refund</span>
        <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0 text-neutral-400" />
        <span className="rounded-lg bg-amber-50 px-2 py-1.5 text-amber-700">Manager&apos;s yes</span>
        <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0 text-neutral-400" />
        <span className="rounded-lg bg-emerald-50 px-2 py-1.5 text-emerald-700">Done</span>
      </div>
      <div className="mt-2.5 text-[11px] text-quiet">New refunds only · waits for your yes</div>
    </div>
  );
}

/**
 * The questions and the conversation side by side: choose one and the
 * chat shows it asked and answered, with what the answer is about
 * floating out in front of it. Every answer is one the product can give
 * today; a mock is a promise, and these are ones that can be kept.
 *
 * Behind the window, the orders coming in: a globe, drawn in WebGL,
 * turning slowly with each city's orders arcing to the store.
 */
export function AskLuke({ asks, after }: { asks: Ask[]; after?: React.ReactNode }) {
  const [at, setAt] = useState(0);
  const panel = useId();
  const shown = asks[at];
  if (!shown) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
      <div className="flex flex-col gap-8">
      <div role="tablist" aria-label="Questions to ask Luke" className="flex flex-col gap-2">
        {asks.map((x, i) => {
          const Icon = ASK_ICON[x.show];
          const on = i === at;
          return (
            <button
              key={x.q}
              role="tab"
              aria-selected={on}
              aria-controls={panel}
              data-cta={`ask_${i + 1}`}
              onClick={() => setAt(i)}
              className={`group flex items-start gap-3 rounded-2xl border px-3.5 py-3 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                on
                  ? "border-accent/40 bg-white shadow-[0_12px_32px_-16px_rgb(49_46_129/0.35)]"
                  : "border-hair bg-white/70 hover:border-neutral-300 hover:bg-white"
              }`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  on ? "bg-accent text-white" : "bg-neutral-100 text-neutral-500 group-hover:text-ink"
                }`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 pt-1">
                <span className="block font-serif text-[1.05rem] leading-snug text-ink">&ldquo;{x.q}&rdquo;</span>
                {on && <span className="mt-1 block text-sm leading-relaxed text-quiet">{x.a}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {after && <div>{after}</div>}
      </div>

      <div className="relative isolate pt-24 sm:pt-28 lg:pt-20 lg:pr-12">
        <OrdersGlobe className="absolute -top-8 -right-16 -z-10 w-72 sm:w-80 lg:-top-20 lg:-right-24 lg:w-[30rem]" />
        <div
          id={panel}
          role="tabpanel"
          aria-live="polite"
          className="relative flex min-h-[24rem] flex-col rounded-2xl border border-hair bg-white shadow-[var(--shadow-dashboard)]"
        >
          <div className="flex items-center gap-2 rounded-t-2xl border-b border-hair px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-200" />
            <span className="ml-2 text-xs text-neutral-400">Warmluke · Luke</span>
          </div>
          <div
            aria-hidden="true"
            className="absolute -top-3.5 right-6"
          >
            <span className="flex items-center gap-1.5 rounded-full border border-hair bg-white px-2.5 py-1 text-[11px] text-ink shadow-[0_12px_24px_-12px_rgb(0_0_0/0.3)]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Shopify connected
            </span>
          </div>
          {/* Keyed on the question, so each answer arrives rather than swaps. */}
          <div key={at} className="flex flex-1 flex-col justify-end gap-4 rounded-b-2xl bg-neutral-50/60 p-5 sm:p-7">
            {/* On a wide screen it hangs out past the window's edge, which is what makes it read as in front. */}
            <div className="self-start lg:-ml-14">
              <div className="rise" style={{ "--rise-after": "0.45s" } as React.CSSProperties}>
                <Artifact show={shown.show} />
              </div>
            </div>
            <div className="rise ml-auto max-w-md rounded-2xl rounded-br-sm bg-accent/10 px-4 py-3 text-sm text-ink">
              {shown.said ?? shown.q}
            </div>
            <div
              className="rise max-w-xl rounded-2xl rounded-bl-sm border border-hair bg-white px-4 py-3 text-sm leading-relaxed text-neutral-700"
              style={{ "--rise-after": "0.25s" } as React.CSSProperties}
            >
              <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-neutral-400">
                {shown.from.map((f) => (
                  <span key={f} className="rounded border border-hair bg-neutral-50 px-1.5 py-0.5">
                    {f}
                  </span>
                ))}
              </div>
              {shown.reply}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The page's sections, in the order the page has them; both navs read this. */
const NAV: Array<{ id: string; label: string; wide?: boolean }> = [
  { id: "luke", label: "Luke" },
  { id: "uses", label: "Use cases" },
  { id: "integrations", label: "Integrations" },
  { id: "mcp", label: "Your own AI", wide: true },
];

/** The section links as one glass pill, for the top of the first screen. */
export function NavLinks() {
  return (
    <div className="hidden items-center gap-0.5 rounded-full border border-hair bg-white/70 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.04)] backdrop-blur-md sm:flex">
      {NAV.map((n) => (
        <a
          key={n.id}
          href={`#${n.id}`}
          data-cta={`nav_${n.id}`}
          className={`rounded-full px-3.5 py-1.5 text-sm text-quiet transition-colors hover:bg-white hover:text-ink ${n.wide ? "hidden md:inline" : ""}`}
        >
          {n.label}
        </a>
      ))}
    </div>
  );
}

/**
 * The navigation once the first screen has scrolled away: a small pill
 * that floats at the top, with the section being read lit from above.
 * The top bar stays where it is on the first screen; this only arrives
 * after it, so the first screen is still exactly one viewport.
 */
export function FloatingNav({ cta }: { cta: string }) {
  const [on, setOn] = useState(false);
  const [here, setHere] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setOn(window.scrollY > window.innerHeight * 0.85);
    };
    const scrolled = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", scrolled, { passive: true });
    // The section whose middle band is on screen is the one being read.
    const look = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setHere(e.target.id);
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    for (const id of [...NAV.map((n) => n.id), "book"]) {
      const el = document.getElementById(id);
      if (el) look.observe(el);
    }
    return () => {
      window.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
      look.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden={!on}
      inert={!on}
      className={`fixed top-3 left-1/2 z-50 -translate-x-1/2 transition-all duration-300 motion-reduce:transition-none ${
        on ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-4 opacity-0"
      }`}
    >
      <nav
        aria-label="Sections"
        className="flex items-center gap-1 rounded-full border border-hair bg-white/80 p-1 pl-2 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.18)] backdrop-blur-md"
      >
        <a href="#top" data-cta="float_top" aria-label="Back to the top" className="mr-1 flex shrink-0 items-center">
          <Logo className="h-4" />
        </a>
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            data-cta={`float_${n.id}`}
            aria-current={here === n.id ? "true" : undefined}
            className={`relative hidden rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors sm:inline ${
              here === n.id ? "bg-accent/10 text-ink" : "text-quiet hover:text-ink"
            }`}
          >
            {n.label}
            {/* The tube light: a bar on top of the section being read, and its glow. */}
            <span
              aria-hidden="true"
              className={`absolute -top-1 left-1/2 h-[3px] w-7 -translate-x-1/2 rounded-full bg-accent transition-opacity duration-300 ${
                here === n.id ? "opacity-100" : "opacity-0"
              }`}
            >
              <span className="absolute -top-2 -left-2.5 h-5 w-12 rounded-full bg-accent/25 blur-md" />
            </span>
          </a>
        ))}
        <a
          href="#book"
          data-cta="float_nav"
          className="ml-1 shrink-0 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium whitespace-nowrap text-white transition-opacity hover:opacity-90"
        >
          {cta}
        </a>
      </nav>
    </div>
  );
}
