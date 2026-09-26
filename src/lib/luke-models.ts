// Which models an account's Luke may answer on, and what each reply
// shows them about it.
//
// On offer: what Anthropic's Models API says this server's key can use,
// kept to the models this app has a price for (model-prices.ts), plus
// the server's own model whatever it is. Asked at most once an hour.
// When it cannot be asked (no key, a replayed run, the API down) the
// current models of the price table stand in; a model the key cannot
// serve is then refused by Anthropic, said like any other failure.
//
// Allowed: what is on offer, cut to the account's list when an
// administrator set one (account_settings.luke_models, 0127). A model
// named in a request and not allowed is never used: the reply is made
// on the account's default instead, and says which model made it.
//
// Callers: src/app/api/models/route.ts, src/app/api/chat/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { designModel } from "@/lib/ai";
import { CURRENT_MODELS, modelName, priceOf, type Price } from "@/lib/model-prices";
import { tapeMode } from "@/lib/model-tape";
import type { LukeShows } from "@/lib/types";

export type OfferedModel = { id: string; name: string; price: Price | null };

export type LukeSettings = {
  /** Newest first, the default among them. */
  models: OfferedModel[];
  default: string | null;
  /** The server's own model, which a turn uses when nothing else is asked for. */
  server: string | null;
  shows: LukeShows;
};

const SHOWS: readonly LukeShows[] = ["nothing", "model", "tokens", "cost"];
const HOUR = 3_600_000;
let asked: { at: number; ids: string[] } | null = null;

/** The ids Anthropic lists for this key, newest first; null when it cannot be asked. */
async function listed(): Promise<string[] | null> {
  // A replayed run makes no call that is not on a tape.
  if (tapeMode()) return null;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const messages = process.env.ANTHROPIC_API_URL?.trim();
  const url = messages ? messages.replace(/\/messages\/?$/, "/models") : "https://api.anthropic.com/v1/models";
  try {
    const r = await fetch(`${url}?limit=100`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
    return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/** What this server can answer on, newest first, with its own model always among them. */
export async function modelsOnOffer(): Promise<{ ids: string[]; fallback: string | null }> {
  let fallback: string | null = null;
  try {
    fallback = designModel();
  } catch {
    /* no model set: nothing to offer beyond the list */
  }
  if (!asked || Date.now() - asked.at > HOUR) {
    const got = await listed();
    // Kept only when it answered, so an outage is asked again next time.
    if (got) asked = { at: Date.now(), ids: got };
  }
  const priced = (asked?.ids ?? CURRENT_MODELS).filter((id) => priceOf(id));
  const ids = fallback && !priced.includes(fallback) ? [fallback, ...priced] : priced;
  return { ids, fallback };
}

const offered = (id: string): OfferedModel => ({ id, name: modelName(id), price: priceOf(id) });

/**
 * What this account may use and see. A list or a setting that cannot be
 * read gives the server's model alone: a restriction that fails open is
 * not one.
 */
export async function lukeSettings(client: SupabaseClient, userId: string): Promise<LukeSettings> {
  const [{ ids, fallback }, { data, error }] = await Promise.all([
    modelsOnOffer(),
    client.from("account_settings").select("luke_models, luke_shows").eq("user_id", userId).maybeSingle(),
  ]);
  if (error)
    return { models: fallback ? [offered(fallback)] : [], default: fallback, server: fallback, shows: "model" };
  const list = Array.isArray(data?.luke_models) ? (data.luke_models as string[]) : null;
  const shows = SHOWS.includes(data?.luke_shows as LukeShows) ? (data!.luke_shows as LukeShows) : "cost";
  const allowed = list ? ids.filter((id) => list.includes(id)) : ids;
  // Everything they were allowed has gone from the offer: the server's
  // model rather than none, so Luke still answers.
  const models = (allowed.length ? allowed : fallback ? [fallback] : []).map(offered);
  const byDefault = fallback && models.some((m) => m.id === fallback) ? fallback : (models[0]?.id ?? null);
  return { models, default: byDefault, server: fallback, shows };
}

/** The model a turn is made on: the one asked for when it is allowed, the default otherwise. */
export function modelFor(settings: LukeSettings, wanted: unknown): string | null {
  return typeof wanted === "string" && settings.models.some((m) => m.id === wanted) ? wanted : settings.default;
}
