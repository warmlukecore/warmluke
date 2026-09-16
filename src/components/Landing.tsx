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

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { UTM_KEYS, type Utm } from "@/lib/landing";

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
      landing_path: window.location.pathname + window.location.search,
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
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const started = useRef(false);

  function began() {
    if (started.current) return;
    started.current = true;
    void record("demo_start", variant);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");

    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") ?? "").slice(0, 120),
      email: String(form.get("email") ?? "").slice(0, 160),
      store: String(form.get("store") ?? "").slice(0, 200),
      note: String(form.get("note") ?? "").slice(0, 600),
    };

    try {
      const { error } = await supabase.from("landing_events").insert({
        session_id: sessionId(),
        variant,
        ...utmFromUrl(),
        landing_path: window.location.pathname + window.location.search,
        event: "demo_booked",
        payload,
      });
      // Told the truth either way. A form that says "thanks" over a
      // failed write loses the lead and nobody ever finds out.
      setState(error ? "failed" : "sent");
    } catch {
      setState("failed");
    }
  }

  if (state === "sent") {
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
    <form onSubmit={submit} onFocusCapture={began} className="grid gap-3 sm:grid-cols-2">
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
          disabled={state === "sending"}
          className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {state === "sending" ? "Sending…" : "Book a Demo"}
        </button>
        {state === "failed" && (
          <span className="text-sm text-amber-300">
            That didn&apos;t send — please try again in a moment.
          </span>
        )}
      </div>
    </form>
  );
}
