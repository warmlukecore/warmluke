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
// The anon key, not the service role: this writes exactly what an
// unauthenticated visitor is allowed to write, and the row is checked
// by the same policy either way. The service role does not belong in a
// deployment.
//
// Read back by the admin screen through abo_admin_demo_requests (0115).
//
// Callers: src/components/Landing.tsx.
// ─────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { UTM_KEYS } from "@/lib/landing";
import { HEARD_OPTIONS, ORDER_OPTIONS, TEAM_OPTIONS, heardDetailPrompt, type Option } from "@/lib/onboarding";

export type BookingState = { ok: boolean; message?: string };

const text = (v: FormDataEntryValue | null, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

/** A value from one of the form's lists, or nothing: a stale or forged one is not stored. */
const pick = (v: FormDataEntryValue | null, options: Option[]) => {
  const s = text(v, 40);
  return options.some((o) => o.value === s) ? s : "";
};

export async function bookDemo(
  _prev: BookingState,
  form: FormData
): Promise<BookingState> {
  const name = text(form.get("name"), 120);
  const email = text(form.get("email"), 160);
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
  if (!name || !email || !store) {
    return { ok: false, message: "Name, email and store are all needed." };
  }
  // The picks are not required here. The form will not send without
  // them, but with JavaScript off it cannot open them at all, and a
  // booking without its picks is still somebody asking for a demo.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "That email address doesn't look right." };
  }

  const url = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: false, message: "Not configured." };

  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = text(form.get(k), 200);
    if (v) utm[k] = v;
  }

  const { error } = await createClient(url, anon).from("landing_events").insert({
    session_id: text(form.get("session_id"), 64) || crypto.randomUUID().replace(/-/g, ""),
    variant: text(form.get("variant"), 64) || null,
    ...utm,
    // Capped here as well as at the column: a query string long enough
    // to fail the check would have failed the booking, which is the one
    // event that must not be lost over a detail nobody reads.
    landing_path: text(form.get("landing_path"), 500) || null,
    event: "demo_booked",
    idem: text(form.get("idem"), 64) || null,
    payload: {
      name,
      email,
      store,
      note: text(form.get("note"), 600),
      team_size,
      monthly_orders,
      heard_from,
      heard_from_detail,
    },
  });

  if (error) {
    // The same submission arriving twice is the unique index doing its
    // job, and the person has already been heard.
    if (error.code === "23505") return { ok: true };
    return { ok: false, message: "That didn't send — please try again in a moment." };
  }
  return { ok: true };
}
