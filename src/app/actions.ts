"use server";

// ─────────────────────────────────────────────────────────────
// Booking a demo, on the server.
//
// The form used to be handled only in the browser, which meant that
// with JavaScript off it fell back to what a form with no action does:
// a GET to the same page. The lead was never written, and the person's
// name, email and store went into the address bar, their history, and
// every log between here and them.
//
// So the submit is a server action. It works with no JavaScript at
// all, and the client component uses the same one — one path, rather
// than a real one and a fallback nobody ever exercises.
//
// The anon key, not the service role, which does not belong in a
// deployment. The booking goes through abo_book_demo with the server's
// own BOOKING_KEY (0160): the public key alone cannot write one, so the
// only way onto the admin's list is this form and its CAPTCHA.
//
// Read back by the admin screen through abo_admin_demo_requests (0115).
//
// With Turnstile set up (both keys), a booking carries the widget's
// token and Cloudflare is asked about it before anything is written.
// That needs JavaScript, so with it off a booking is refused there; the
// form is what bots fill in, and they are the ones it is for.
//
// Callers: src/components/Landing.tsx.
// ─────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { leadEventId, sendMetaLead } from "@/lib/meta-conversions";
import { UTM_KEYS } from "@/lib/landing";
import { HEARD_OPTIONS, ORDER_OPTIONS, TEAM_OPTIONS, heardDetailPrompt, type Option } from "@/lib/onboarding";

export type BookingState = { ok: boolean; message?: string; eventId?: string };

const text = (v: FormDataEntryValue | null, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

/** A value from one of the form's lists, or nothing: a stale or forged one is not stored. */
const pick = (v: FormDataEntryValue | null, options: Option[]) => {
  const s = text(v, 40);
  return options.some((o) => o.value === s) ? s : "";
};

/**
 * Cloudflare's word on the widget's token. Refused only when Cloudflare
 * says no: an outage there is not a reason to lose a lead, and nobody
 * sending the form can cause one.
 */
async function person(form: FormData): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) return true;
  const response = text(form.get("cf-turnstile-response"), 2048);
  if (!response) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response }),
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { success?: boolean };
    return r.ok ? j.success === true : true;
  } catch {
    return true;
  }
}

export async function bookDemo(_prev: BookingState, form: FormData): Promise<BookingState> {
  const name = text(form.get("name"), 120);
  const email = text(form.get("email"), 160);
  // What the invite made from this request is addressed to (0141).
  const business = text(form.get("business"), 160);
  const store = text(form.get("store"), 200);
  // The same lists onboarding asks from, so a lead and an account are
  // described in the same words on the admin screen.
  const team_size = pick(form.get("team_size"), TEAM_OPTIONS);
  const monthly_orders = pick(form.get("monthly_orders"), ORDER_OPTIONS);
  const heard_from = pick(form.get("heard_from"), HEARD_OPTIONS);
  // Only kept where the form asks for it: a detail left behind after
  // the answer above it changed would describe the wrong answer.
  const heard_from_detail = heardDetailPrompt(heard_from) ? text(form.get("heard_from_detail"), 200) : "";

  // The browser checks these too; the browser is not the one to ask.
  if (!name || !email || !business || !store) {
    return { ok: false, message: "Name, email, business and store are all needed." };
  }
  // The picks are not required here. The form will not send without
  // them, but with JavaScript off it cannot open them at all, and a
  // booking without its picks is still somebody asking for a demo.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "That email address doesn't look right." };
  }

  if (!(await person(form))) {
    return { ok: false, message: "We couldn’t check this browser. Wait a moment and send it again." };
  }

  const url = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
  const key = process.env.BOOKING_KEY;
  if (!url || !anon || !key) return { ok: false, message: "Not configured." };

  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = text(form.get(k), 200);
    if (v) utm[k] = v;
  }

  const session = text(form.get("session_id"), 64) || crypto.randomUUID().replace(/-/g, "");
  const idem = text(form.get("idem"), 64) || crypto.randomUUID().replace(/-/g, "");
  const eventId = leadEventId(session, idem);
  const eventTime = Math.floor(Date.now() / 1000);
  const { error } = await createClient(url, anon).rpc("abo_book_demo", {
    p_key: key,
    p_booking: {
      session_id: session,
      variant: text(form.get("variant"), 64) || null,
      ...utm,
      // Capped here as well as at the column: a query string long enough
      // to fail the check would have failed the booking, which is the one
      // event that must not be lost over a detail nobody reads.
      landing_path: text(form.get("landing_path"), 500) || null,
      idem,
      payload: {
        name,
        email,
        business,
        store,
        note: text(form.get("note"), 600),
        team_size,
        monthly_orders,
        heard_from,
        heard_from_detail,
      },
    },
  });

  if (error) {
    // The same submission arriving twice is the unique index doing its
    // job, and the person has already been heard.
    if (error.code === "23505") return { ok: true, eventId };
    return { ok: false, message: "That didn't send — please try again in a moment." };
  }
  after(async () => {
    try {
      const h = await headers();
      // Sent only on the visitor's yes, said by the form (lib/consent): a
      // form without it (script off, never asked, a request made by hand)
      // is a no, never a silent yes.
      if (h.get("sec-gpc") === "1" || h.get("dnt") === "1" || form.get("meta_consent") !== "1") return;
      // Configured canonical URL, not a client-supplied URL or store address.
      const source = process.env.META_EVENT_SOURCE_URL;
      if (!source) return;
      const sourceUrl = new URL(source);
      if (sourceUrl.protocol !== "https:" && sourceUrl.hostname !== "localhost") return;
      sourceUrl.search = "";
      sourceUrl.hash = "";
      const c = await cookies();
      await sendMetaLead({
        eventId,
        eventTime,
        email,
        sourceUrl: sourceUrl.href,
        fbp: c.get("_fbp")?.value,
        fbc: c.get("_fbc")?.value || text(form.get("meta_fbc"), 512),
        // Vercel replaces this header; do not trust arbitrary forwarded IPs.
        ip: h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim(),
        userAgent: h.get("user-agent") ?? undefined,
      });
    } catch {
      console.warn("Meta Lead: configuration or delivery failure");
    }
  });
  return { ok: true, eventId };
}
