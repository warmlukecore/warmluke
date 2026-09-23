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
// Each resource names its own topics beside its queries, so a resource
// added there is subscribed here without anyone remembering to.
export { WEBHOOK_TOPICS } from "@/lib/shopify-resources";
import { WEBHOOK_TOPICS } from "@/lib/shopify-resources";

/**
 * Topics about the app itself rather than any resource, each with the
 * database function that handles it. The webhook route sends these
 * there instead of the resource dispatcher; check-shopify holds that
 * each is subscribed, routed, and defined in a migration.
 */
export const LIFECYCLE_TOPICS: Readonly<Record<string, string>> = {
  // The merchant removed the app: the store is marked for it and its
  // dead token dropped (0111), rather than left "connected" and failing.
  APP_UNINSTALLED: "abo_shopify_uninstalled",
};

/** Every topic a store is subscribed to at connect. */
const SUBSCRIBED: readonly string[] = [...WEBHOOK_TOPICS, ...Object.keys(LIFECYCLE_TOPICS)];

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

const EXISTING = `
query {
  webhookSubscriptions(first: 100) {
    nodes {
      id
      topic
      endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
    }
  }
}`;

const MOVE = `
mutation($id: ID!, $url: URL!) {
  webhookSubscriptionUpdate(
    id: $id
    webhookSubscription: { callbackUrl: $url }
  ) {
    webhookSubscription { id }
    userErrors { message }
  }
}`;

export type SubscribeResult = {
  added: string[];
  already: string[];
  moved: string[];
  failed: string[];
};

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
  const out: SubscribeResult = { added: [], already: [], moved: [], failed: [] };

  // What the shop already has. A subscription pointed at our old
  // address is not something to add beside — it is the same topic at
  // the wrong URL, and creating a second one either fails or leaves
  // Shopify still delivering to an address that no longer exists.
  // webhookSubscriptionUpdate moves it in one step.
  // Every subscription for a topic, not the last one seen. A shop can
  // hold more than one, and keeping a single entry per topic left the
  // others pointed at an address that no longer answers — quietly, and
  // looking exactly like a tidy run.
  const existing = new Map<string, Array<{ id: string; url: string }>>();
  try {
    const data = await graphql<{
      webhookSubscriptions: {
        nodes: Array<{ id: string; topic: string; endpoint: { callbackUrl?: string } | null }>;
      };
    }>(shop, token, EXISTING, {});
    for (const n of data.webhookSubscriptions.nodes) {
      const list = existing.get(n.topic) ?? [];
      list.push({ id: n.id, url: n.endpoint?.callbackUrl ?? "" });
      existing.set(n.topic, list);
    }
  } catch (e) {
    // Not silent. Without this list every topic looks absent, so the
    // loop creates beside whatever is already there and the shop keeps
    // delivering to the old address — the exact failure this listing
    // was added to prevent, wearing the face of a clean run.
    out.failed.push(
      `existing subscriptions could not be listed: ${e instanceof Error ? e.message : "failed"}`
    );
    return out;
  }

  for (const topic of SUBSCRIBED) {
    try {
      const have = existing.get(topic) ?? [];
      if (have.length > 0) {
        // Each of them is moved rather than one moved and the rest
        // abandoned. Nothing is deleted: these are subscriptions on a
        // merchant's shop, and a duplicate delivery costs an idempotent
        // upsert while a deletion cannot be taken back. Shopify refuses
        // a second move onto an address it already holds, and that
        // refusal is reported rather than swallowed.
        let settled = false;
        for (const one of have) {
          if (one.url === callbackUrl) {
            settled = true;
            continue;
          }
          const data = await graphql<{
            webhookSubscriptionUpdate: {
              webhookSubscription: { id: string } | null;
              userErrors: Array<{ message: string }>;
            };
          }>(shop, token, MOVE, { id: one.id, url: callbackUrl });
          const { webhookSubscription, userErrors } = data.webhookSubscriptionUpdate;
          if (webhookSubscription) {
            settled = true;
            out.moved.push(topic);
          } else if (userErrors.some((e) => /already|taken/i.test(e.message))) {
            // Another subscription for this topic already sits there.
            settled = true;
          } else {
            // The URL is deliberately not in the message. This string
            // ends up in stores.webhook_error, which the app shows to
            // every member of the project — and the address is what
            // decides which store a delivery belongs to.
            out.failed.push(
              `${topic} (could not be moved): ${userErrors.map((e) => e.message).join("; ")}`
            );
          }
        }
        if (settled && !out.moved.includes(topic)) out.already.push(topic);
        continue;
      }

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
