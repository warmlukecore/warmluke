"use client";

// ─────────────────────────────────────────────────────────────
// The two things on the landing page that are not just words.
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
import { supabase } from "@/lib/supabase-client";
import { UTM_KEYS, type Utm } from "@/lib/landing";
import { bookDemo, type BookingState } from "@/app/actions";

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
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-8 text-center">
        <div className="font-display text-xl font-semibold text-emerald-300">
          Got it — we&apos;ll be in touch.
        </div>
        <p className="mt-2 text-sm text-slate-400">
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
        className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-blue-500/50"
      />
      <input
        name="email"
        type="email"
        required
        placeholder="Work email"
        className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-blue-500/50"
      />
      <input
        name="store"
        required
        placeholder="Your store URL"
        className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-blue-500/50 sm:col-span-2"
      />
      <textarea
        name="note"
        rows={3}
        placeholder="What would you ask Luke to fix first?"
        className="resize-none rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-blue-500/50 sm:col-span-2"
      />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          data-cta="book"
          className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "Sending\u2026" : "Book a Demo"}
        </button>
        {state.message && <span className="text-sm text-amber-300">{state.message}</span>}
      </div>
    </form>
  );
}
