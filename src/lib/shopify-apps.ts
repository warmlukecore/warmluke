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

/**
 * Every app that may have signed what Shopify sent about one shop: the
 * apps claiming it that are on (a merchant's own, an administrator's,
 * 0156), then the main app. Shopify signs with the app it is answering
 * for, so the signature says which one — the shop alone no longer can,
 * since more than one account may have set an app up for it.
 */
export async function appsForShop(shop: string, env: Env = process.env): Promise<ShopifyApp[]> {
  const main = mainApp(env);
  const key = env.SHOPIFY_APPS_KEY;
  const client = key ? db(env) : null;
  if (!client) return main ? [main] : [];
  const { data, error } = await client.rpc("abo_shopify_apps_for", { p_shop: shop, p_key: key });
  if (error) throw new Error(`Couldn't read which Shopify apps ${shop} may come through: ${error.message}`);
  const own = ((data ?? []) as Array<{ client_id: string; client_secret: string; all_orders: boolean }>).map((a) => ({
    clientId: a.client_id,
    clientSecret: a.client_secret,
    own: true,
    allOrders: a.all_orders,
  }));
  return [...own, ...(main ? [main] : [])];
}

/**
 * Whether the app that signed a callback may connect the store it names:
 * the main app, an administrator's for the shop, or the store owner's own
 * (0156). Asked before any token is taken. A deployment with no apps of
 * its own has only the main app, which may.
 */
export async function claimOk(shop: string, app: ShopifyApp, state: string, env: Env = process.env): Promise<boolean> {
  if (!app.own) return true;
  const key = env.SHOPIFY_APPS_KEY;
  const client = key ? db(env) : null;
  if (!client) return false;
  const { data, error } = await client.rpc("abo_shopify_claim_ok", {
    p_shop: shop,
    p_client_id: app.clientId,
    p_state: state,
    p_key: key,
  });
  return !error && data === true;
}

/**
 * The shop came through this app: its deliveries and token renewals use
 * it from now on (0156). Never fatal — the store is connected either way,
 * and the next connection says it again.
 */
export async function cameThrough(shop: string, app: ShopifyApp, env: Env = process.env): Promise<void> {
  const key = env.SHOPIFY_APPS_KEY;
  const client = key ? db(env) : null;
  if (!client) return;
  const { error } = await client.rpc("abo_shopify_came_through", {
    p_shop: shop,
    p_client_id: app.own ? app.clientId : null,
    p_key: key,
  });
  if (error) console.error(`could not record which app ${shop} came through:`, error.message);
}

/** The first app whose secret the check accepts, or null. All apps unless told which to try. */
export async function firstThatSigned(
  check: (secret: string) => void,
  env: Env = process.env,
  apps?: ShopifyApp[]
): Promise<ShopifyApp | null> {
  for (const app of apps ?? (await allApps(env))) {
    try {
      check(app.clientSecret);
      return app;
    } catch {
      /* the next one */
    }
  }
  return null;
}
