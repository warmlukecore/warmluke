// ─────────────────────────────────────────────────────────────
// The app subscribes its own webhooks.
//
// There is no shopify.app.toml here and no CLI deploy, so nothing
// declares these for us — and the Partner Dashboard only offers the
// compliance topics. That left every other topic as something a person
// had to remember to click, per app version, forever. The one they
// forget is the one that silently stops a merchant's stock from
// updating, and nothing anywhere says so.
//
// So it happens at connect, with the token we were just handed.
//
// Callers: src/app/api/shopify/callback/route.ts,
// scripts/subscribe-webhooks.mjs.
// ─────────────────────────────────────────────────────────────

import { graphql } from "@/lib/shopify-import";

/**
 * What the app asks to hear about.
 *
 * Every topic here has a handler in the webhook route; a topic without
 * one would be signed, accepted and ignored, which looks exactly like
 * working. The compliance topics are not listed: Shopify manages those
 * from the app's own settings and refuses to let an app subscribe to
 * them itself.
 */
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
  "ORDERS_FULFILLED",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
  "INVENTORY_LEVELS_CONNECT",
] as const;

const CREATE = `
mutation($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(
    topic: $topic
    webhookSubscription: { callbackUrl: $url, format: JSON }
  ) {
    webhookSubscription { id }
    userErrors { message }
  }
}`;

export type SubscribeResult = { added: string[]; already: string[]; failed: string[] };

/**
 * Subscribes every topic, and says what happened to each.
 *
 * Idempotent by Shopify's own behaviour: asking again for a topic
 * already pointed at the same address comes back as a user error
 * saying so, which is a success as far as this is concerned.
 *
 * One failure does not stop the rest. A store with eleven of thirteen
 * topics is worth more than a store with none, and the caller is told
 * which two are missing rather than the whole thing being an error.
 */
export async function subscribeWebhooks(
  shop: string,
  token: string,
  callbackUrl: string
): Promise<SubscribeResult> {
  const out: SubscribeResult = { added: [], already: [], failed: [] };

  for (const topic of WEBHOOK_TOPICS) {
    try {
      const data = await graphql<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(shop, token, CREATE, { topic, url: callbackUrl });

      const { webhookSubscription, userErrors } = data.webhookSubscriptionCreate;
      if (webhookSubscription) out.added.push(topic);
      else if (userErrors.some((e) => /already|taken/i.test(e.message))) out.already.push(topic);
      else out.failed.push(`${topic}: ${userErrors.map((e) => e.message).join("; ")}`);
    } catch (e) {
      out.failed.push(`${topic}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return out;
}
