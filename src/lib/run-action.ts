// ─────────────────────────────────────────────────────────────
// Doing the change, once, and writing down what happened.
//
// Everything dangerous about this is arranged so it cannot be
// skipped by whoever calls it:
//
//   the claim is the first thing and the database owns it, so two
//   approvals arriving together produce one run;
//   once claimed, the row MUST be finished — every path below ends
//   at abo_action_done, including the ones that throw, or the row
//   sits in "running" for ever and the merchant is told their
//   change is still going;
//   the scopes are checked here rather than discovered as fifty
//   identical refusals from Shopify.
//
// What it does NOT decide: whether this was allowed. That happened
// in SQL, before this ran, and this cannot approve anything.
//
// Callers: to come — the route the panel calls, src/app/api/mcp/route.ts.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { graphql } from "@/lib/shopify-import";
import { ShopifyError } from "@/lib/shopify";
import { actionSpec, MOST_TARGETS, type ActionParams, type ActionTarget } from "@/lib/store-actions";

export interface ActionRun {
  /** What the row says now: done, partly_done, failed — or why nothing ran. */
  status: string;
  /** Shopify ids this really changed. */
  done: string[];
  /** One line per thing that did not happen. */
  errors: string[];
}

const message = (e: unknown): string =>
  e instanceof ShopifyError || e instanceof Error ? e.message : "Something went wrong.";

/**
 * Runs an approved change and records the outcome.
 *
 * `db` is the merchant's own client. It has to be: the token comes
 * from abo_store_token, which answers the owner and refuses a token
 * carrying a client_id, and approving is the merchant's alone. A
 * connected assistant can reach this only by asking them first.
 */
export async function runAction(
  db: SupabaseClient,
  actionId: string,
  env: Record<string, string | undefined> = process.env
): Promise<ActionRun> {
  void env;
  const { data: claimed, error: claimError } = await db.rpc("abo_action_claim", {
    p_action: actionId,
  });
  const claim = claimed as {
    claimed: boolean;
    status?: string;
    action?: string;
    store_id?: string;
    targets?: ActionTarget[];
    params?: ActionParams;
  } | null;

  if (claimError) return { status: "failed", done: [], errors: [claimError.message] };
  if (!claim?.claimed) {
    // Not ours to run: already running, already finished, never
    // approved, or not theirs at all. Nothing is written — the row
    // belongs to whoever did claim it.
    return { status: claim?.status ?? "not waiting", done: [], errors: [] };
  }

  const done: string[] = [];
  const errors: string[] = [];

  // From here the row is "running" and this function owns finishing
  // it. Everything is inside the try so a throw still lands below.
  try {
    const spec = actionSpec(claim.action ?? "");
    const targets = Array.isArray(claim.targets) ? claim.targets : [];
    const params = (claim.params ?? {}) as ActionParams;

    if (!spec) {
      errors.push(`Warmluke does not know how to "${claim.action}".`);
    } else if (spec.connector !== "shopify") {
      errors.push(`Nothing here can talk to ${spec.connector} yet.`);
    } else if (targets.length > MOST_TARGETS) {
      // Checked again here, not only where it was proposed: the row
      // may have been made before the ceiling existed.
      errors.push(
        `This would change ${targets.length} things at once, and ${MOST_TARGETS} is the most one change may touch. Ask for it in smaller pieces.`
      );
    } else {
      const wrong = spec.check(targets, params);
      if (wrong) {
        errors.push(wrong);
      } else {
        const { data: store } = await db
          .from("stores")
          .select("id, shop_domain, status, granted_scopes")
          .eq("id", claim.store_id!)
          .maybeSingle();

        if (!store || store.status !== "connected") {
          errors.push("That store is not connected any more.");
        } else {
          // Said once, before anything is attempted. Without this the
          // merchant gets one refusal per target, all of them the
          // same, and none of them saying what to do about it.
          const granted = (store.granted_scopes ?? []) as string[];
          const short = granted.length ? spec.scopes.filter((s) => !granted.includes(s)) : spec.scopes;
          if (short.length) {
            errors.push(
              `This store has not allowed Warmluke to ${short.join(", ")}. Reconnect it to grant that, then ask again. Nothing was changed.`
            );
          } else {
            const { data: secret } = await db.rpc("abo_store_token", { p_store: store.id }).maybeSingle();
            const token = (secret as { access_token?: string } | null)?.access_token;
            if (!token) {
              errors.push("Warmluke could not read this store's access token.");
            } else {
              for (const target of targets) {
                try {
                  const answer = await graphql<unknown>(
                    store.shop_domain,
                    token,
                    spec.mutation,
                    spec.variables(target, params)
                  );
                  const refused = spec.errors(answer);
                  if (refused.length) errors.push(`${target.id}: ${refused.join("; ")}`);
                  else done.push(target.id);
                } catch (e) {
                  errors.push(`${target.id}: ${message(e)}`);
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    errors.push(message(e));
  }

  const { data: finished } = await db.rpc("abo_action_done", {
    p_action: actionId,
    p_outcome: { done, errors },
  });
  return {
    status: (finished as { status?: string } | null)?.status ?? "failed",
    done,
    errors,
  };
}
