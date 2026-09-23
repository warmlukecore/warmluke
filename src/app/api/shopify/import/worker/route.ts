import { after, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ticketClient } from "@/lib/supabase-server";
import { importStep } from "@/lib/import-step";

export const runtime = "nodejs";
// The work runs in after(), which lives as long as this does: several
// steps, each inside a minute, with room to hand over before the
// platform stops it.
export const maxDuration = 300;

/** Work this long, then hand over to a fresh ticket and a fresh request. */
const BUDGET_MS = 200_000;
/** Each renewal keeps the ticket past the longest step. */
const LEASE_SECONDS = 360;

type HeldStore = {
  id: string;
  shop_domain: string;
  status: string;
  last_synced_at: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

/**
 * POST /api/shopify/import/worker — a store's import, with nobody watching.
 *
 * Called by the database, never by a person: abo_import_dispatch posts
 * { store, ticket } here when a store has import work. The ticket is
 * the whole of this route's authority. It is not checked here against
 * a secret the server holds — there is none — but by the database,
 * which minted it for one store, keeps only its hash, and lets it
 * reach that store's commerce rows until it lapses. A made-up ticket,
 * a stale one, or one for another store is turned away before any
 * work is scheduled, and could not have done anything anyway.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { store?: unknown; ticket?: unknown } | null;
  const store = typeof body?.store === "string" ? body.store : null;
  const ticket = typeof body?.ticket === "string" ? body.ticket : null;
  // The shape only. Whether it is real is the database's to say.
  if (!store || !ticket || ticket.length < 32 || ticket.length > 256) {
    return NextResponse.json({ error: "Not an import job." }, { status: 400 });
  }

  const db = ticketClient(ticket);
  const held = await heldStore(db);
  if (!held || held.id !== store) {
    return NextResponse.json({ error: "No such import job." }, { status: 401 });
  }

  // Answered at once: the database's request waits for nobody, and
  // the work carries on after it.
  after(() => work(db, store));
  return NextResponse.json({ accepted: true }, { status: 202 });
}

/** The store this ticket is for, with its token — or null once it lapses. */
async function heldStore(db: SupabaseClient): Promise<HeldStore | null> {
  const { data, error } = await db.rpc("abo_import_store");
  if (error) {
    console.error("import worker: could not read its store:", error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : null) as HeldStore | null;
  return row?.access_token ? row : null;
}

async function work(db: SupabaseClient, storeId: string) {
  const deadline = Date.now() + BUDGET_MS;
  try {
    for (;;) {
      // Read again every step: a renewed Shopify token lands in the
      // row, and a ticket that has lapsed ends the run here.
      const store = await heldStore(db);
      if (!store || store.id !== storeId) return;

      const step = await importStep(db, store, { honourBackoff: true });
      // Finished; waiting on Shopify's export; waiting out a failure;
      // or failed just now, with when to try again already recorded.
      // Each is picked up by the next tick when there is something to do.
      if (step.status !== 200 || step.body.done || step.body.waiting || step.body.held) return;

      // More to do. Past the budget, or past what one ticket may be
      // renewed for, the rest goes to a fresh ticket and request.
      const { data: renewed } = await db.rpc("abo_import_renew", { p_seconds: LEASE_SECONDS });
      if (Date.now() > deadline || renewed !== true) {
        const { data: next, error } = await db.rpc("abo_import_continue");
        if (error || next !== "sent") {
          console.error("import worker: could not hand over:", error?.message ?? next);
        }
        return;
      }
    }
  } catch (e) {
    console.error("import worker:", e instanceof Error ? e.message : e);
  } finally {
    // Frees the store for the next dispatch. After a hand-over this
    // ticket has no lease left and it deletes nothing.
    const { error } = await db.rpc("abo_import_release");
    if (error) console.error("import worker: could not release the store:", error.message);
  }
}
