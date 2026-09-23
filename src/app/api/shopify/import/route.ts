import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { importStep } from "@/lib/import-step";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/shopify/import — the owner's side of a store's import.
 *
 *   { kick }    start it on the server: the database sends it to the
 *               worker, which carries on with the tab closed. Answers
 *               what the database said — "not_configured" means there
 *               is no worker here, and the caller should drive it.
 *   { retry }   the merchant's "try again": failures nobody would
 *               retry on their own go back in the queue.
 *   { status }  where it stands, reading nothing from Shopify.
 *   { recheck } read Shopify over again, from the start.
 *   {}          one page, as the merchant — the way it ran before the
 *               worker, and still the way it runs without one.
 *
 * The step itself lives in lib/import-step, which the worker runs too.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { projectId, recheck, status, kick, retry } = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    recheck?: boolean;
    status?: boolean;
    kick?: boolean;
    retry?: boolean;
  };
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  // RLS decides whether this store is reachable; there is no owner check
  // here because that would be a second opinion on the same question.
  const { data: found } = await auth.client
    .from("stores")
    .select("id, shop_domain, status, last_synced_at")
    .eq("project_id", projectId)
    .maybeSingle();

  if (!found) return NextResponse.json({ error: "No store connected." }, { status: 404 });

  // Asking changes nothing but who is working on it, and the database
  // decides whether this caller may ask: the store's owner, or their
  // own assistant — which starts the import and is handed nothing.
  if (kick) {
    const { data: kicked, error } = await auth.client.rpc("abo_import_kick", { p_store: found.id });
    if (error) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ kicked });
  }

  if (retry) {
    // Only what nobody would try again: a failure still waiting out its
    // pause will be tried anyway, and resetting its count would let a
    // merchant tapping the button spend Shopify's patience for them.
    const { error } = await auth.client
      .from("import_runs")
      .update({ status: "pending", attempts: 0, retry_at: null, error: null })
      .eq("store_id", found.id)
      .eq("status", "failed")
      .is("retry_at", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ retried: true });
  }

  // The token is no longer a column anyone may select — a seat on the
  // project used to be enough to read it. It comes through a function
  // that answers the owner and nobody else, least of all a connected
  // AI client holding their session.
  const { data: secret } = await auth.client.rpc("abo_store_token", { p_store: found.id }).maybeSingle();
  const store = { ...found, ...(secret ?? {}) } as typeof found & {
    access_token?: string | null;
    refresh_token?: string | null;
    token_expires_at?: string | null;
  };

  if (store.status !== "connected" || !store.access_token) {
    return NextResponse.json({ error: "That store isn't connected yet." }, { status: 409 });
  }

  const step = await importStep(auth.client, { ...store, access_token: store.access_token }, { status, recheck });
  return NextResponse.json(step.body, { status: step.status });
}
