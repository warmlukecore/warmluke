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
// Callers: src/components/Landing.tsx.
// ─────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { UTM_KEYS } from "@/lib/landing";

export type BookingState = { ok: boolean; message?: string };

const text = (v: FormDataEntryValue | null, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

export async function bookDemo(
  _prev: BookingState,
  form: FormData
): Promise<BookingState> {
  const name = text(form.get("name"), 120);
  const email = text(form.get("email"), 160);
  const store = text(form.get("store"), 200);

  // The browser checks these too; the browser is not the one to ask.
  if (!name || !email || !store) {
    return { ok: false, message: "Name, email and store are all needed." };
  }
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
    payload: { name, email, store, note: text(form.get("note"), 600) },
  });

  if (error) {
    // The same submission arriving twice is the unique index doing its
    // job, and the person has already been heard.
    if (error.code === "23505") return { ok: true };
    return { ok: false, message: "That didn't send — please try again in a moment." };
  }
  return { ok: true };
}
