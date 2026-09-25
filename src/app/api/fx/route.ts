import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────
// GET /api/fx?from=USD&to=INR — one rate, cached for a day.
//
// A merchant whose shop sells in one currency and whose project is set
// to another has to be shown one of two things: the real number in the
// shop's currency, or a converted number that says it was converted.
// The one thing that must never happen is the real number wearing the
// other currency's symbol, which is what "just show what they picked"
// would quietly mean.
//
// Cached in the database rather than per browser, so two people
// looking at the same order see the same amount, and a hundred
// merchants are not a hundred calls a minute to somebody else's API.
//
// Rates come from the ECB via frankfurter.app: no key, no account, and
// it reports the DAY its rate is from — which is the part that lets the
// app say how old the number is instead of implying it is live.
//
// When there is no rate this says so, and the caller falls back to
// showing the shop's own currency. Nothing here ever invents one.
//
// Callers: src/components/AppShell.tsx.
// ─────────────────────────────────────────────────────────────

const CODE = /^[A-Z]{3}$/;

/** Rates move slowly enough that a day old is honest, said out loud. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Past this, a cached rate stops being an answer.
 *
 * Without it, a pair whose refresh keeps failing would serve the same
 * number for ever — marked stale, but served — and a month-old rate
 * quietly becomes a wrong price rather than an old one. Beyond this the
 * amounts go back to the shop's own currency, which is always true.
 */
const REFUSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Postgres numeric permits NaN and Infinity, and both survive Number(). */
const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const url = new URL(req.url);
  const from = (url.searchParams.get("from") ?? "").toUpperCase();
  const to = (url.searchParams.get("to") ?? "").toUpperCase();
  // The cache belongs to a project, so which one has to be said. RLS
  // and the writing function both check it against the caller; this is
  // only the question, never the permission.
  const project = url.searchParams.get("project") ?? "";

  if (!project) return NextResponse.json({ error: "project_required" }, { status: 400 });
  if (!CODE.test(from) || !CODE.test(to)) {
    return NextResponse.json({ error: "bad_currency" }, { status: 400 });
  }
  // Not a conversion at all, and worth answering without a round trip.
  if (from === to) {
    return NextResponse.json({ rate: 1, as_of: null, same: true });
  }

  const { data: cached } = await auth.client
    .from("fx_rates")
    .select("rate, as_of, fetched_at")
    .eq("project_id", project)
    .eq("base", from)
    .eq("quote", to)
    .maybeSingle();

  // numeric comes back as a string, and a stored NaN would pass
  // `rate > 0` in Postgres — NaN sorts above every number there — then
  // multiply every amount into NaN here. Checked on the way out, not
  // only on the way in.
  const cachedRate = cached ? Number(cached.rate) : null;
  const cachedAgeMs = cached ? Date.now() - new Date(cached.fetched_at as string).getTime() : Infinity;
  const cachedUsable = usable(cachedRate) && cachedAgeMs < REFUSE_AFTER_MS;

  if (cachedUsable && cachedAgeMs < STALE_AFTER_MS) {
    return NextResponse.json({ rate: cachedRate, as_of: cached!.as_of });
  }

  try {
    const res = await fetch(`https://api.frankfurter.app/latest?base=${from}&symbols=${to}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`rate source answered ${res.status}`);

    const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
    const rate = body.rates?.[to];
    // Missing, zero, negative or not a number would make every amount
    // wrong in a way that still renders perfectly.
    if (!usable(rate)) throw new Error("rate source sent no usable rate");

    // Looked at, not fired and forgotten. A write that silently failed
    // would mean the cache never fills and every page load goes back
    // out to the rate source — and a caller asking about a project
    // that is not theirs would be told a cheerful yes.
    const { error: stored } = await auth.client.rpc("abo_fx_put", {
      p_project: project,
      p_base: from,
      p_quote: to,
      p_rate: rate,
      p_as_of: body.date ?? null,
    });
    if (stored) {
      if (stored.code === "42501") {
        return NextResponse.json({ error: "not_your_project" }, { status: 403 });
      }
      // The rate itself is sound; only keeping it failed. Answer with
      // it and let the next request try to cache again.
      console.error("could not cache the rate:", stored.message);
    }

    return NextResponse.json({ rate, as_of: body.date ?? null });
  } catch (e) {
    // A stale rate, clearly labelled, beats no amount at all — but only
    // because the caller is told how old it is. A rate we never had
    // stays absent, and the shop's own currency is shown instead.
    // A day-old rate, clearly labelled, beats no amount at all. A
    // week-old one does not, and neither does an unusable one.
    if (cachedUsable) {
      return NextResponse.json({ rate: cachedRate, as_of: cached!.as_of, stale: true });
    }
    return NextResponse.json(
      { error: "no_rate", why: e instanceof Error ? e.message : "unavailable" },
      { status: 503 }
    );
  }
}
