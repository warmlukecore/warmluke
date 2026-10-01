// Which Shopify app a store comes through (0150).
//
// The main app is the one in the environment (SHOPIFY_CLIENT_ID and
// SHOPIFY_CLIENT_SECRET): every store came through it until stores could
// come through an app of their own, set up by an administrator for one
// merchant before the public app is approved. Those are kept in the
// database, their secrets in its vault, and read here with the server's
// own key (SHOPIFY_APPS_KEY), which reads nothing else. Without that key
// there are no apps of a store's own, and everything is as it was.
//
// Callers: src/app/api/shopify/{start,install,entry,callback}/route.ts,
// src/app/api/shopify/webhooks/{[token],compliance}/route.ts,
// src/lib/shopify-import.ts.

import { createClient } from "@supabase/supabase-js";

export type ShopifyApp = {
  clientId: string;
  clientSecret: string;
  /** The store's own app, not the main one. */
  own: boolean;
  /** Shopify gave the app read_all_orders, so the install asks for history past 60 days. */
  allOrders: boolean;
};

type Env = Record<string, string | undefined>;

/** A store whose own app an administrator switched off: nothing is done for it until it is on again. */
export class AppSwitchedOff extends Error {
  constructor(shop: string) {
    super(`The Shopify app for ${shop} is switched off in Warmluke's admin.`);
  }
}

export function mainApp(env: Env = process.env): ShopifyApp | null {
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  return clientId && clientSecret
    ? { clientId, clientSecret, own: false, allOrders: env.SHOPIFY_READ_ALL_ORDERS === "true" }
    : null;
}

const db = (env: Env) =>
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL && env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
    ? createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      })
    : null;

/**
 * The app a store comes through: its own when one is set up for it, the
 * main app otherwise. Throws AppSwitchedOff for a store whose own app is
 * off, so it is never quietly sent through the main app instead.
 */
export async function appForShop(shop: string, env: Env = process.env): Promise<ShopifyApp | null> {
  const key = env.SHOPIFY_APPS_KEY;
  const client = key ? db(env) : null;
  if (client) {
    const { data, error } = await client.rpc("abo_shopify_app_for", { p_shop: shop, p_key: key });
    if (error) throw new Error(`Couldn't read which Shopify app ${shop} comes through: ${error.message}`);
    const own = (
      data as Array<{ client_id: string; client_secret: string | null; all_orders: boolean; enabled: boolean }> | null
    )?.[0];
    if (own) {
      if (!own.enabled || !own.client_secret) throw new AppSwitchedOff(shop);
      return { clientId: own.client_id, clientSecret: own.client_secret, own: true, allOrders: own.all_orders };
    }
  }
  return mainApp(env);
}

/** Every app a delivery may be signed by: the main one and each store's own that is on. */
export async function allApps(env: Env = process.env): Promise<ShopifyApp[]> {
  const main = mainApp(env);
  const key = env.SHOPIFY_APPS_KEY;
  const client = key ? db(env) : null;
  if (!client) return main ? [main] : [];
  const { data, error } = await client.rpc("abo_shopify_app_secrets", { p_key: key });
  // A database that cannot be read still lets the main app's deliveries in.
  const own = error
    ? []
    : ((data ?? []) as Array<{ client_id: string; client_secret: string }>).map((a) => ({
        clientId: a.client_id,
        clientSecret: a.client_secret,
        own: true,
        allOrders: false,
      }));
  return [...(main ? [main] : []), ...own];
}

/** The first app whose secret the check accepts, or null. */
export async function firstThatSigned(
  check: (secret: string) => void,
  env: Env = process.env
): Promise<ShopifyApp | null> {
  for (const app of await allApps(env)) {
    try {
      check(app.clientSecret);
      return app;
    } catch {
      /* the next one */
    }
  }
  return null;
}
