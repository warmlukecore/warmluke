import { after, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectorTicketClient } from "@/lib/supabase-server";
import { ADAPTERS } from "@/lib/connectors/adapters";
import { ConnectorBusy, ConnectorRefused, type Job, type ListRows, type ShipmentRow } from "@/lib/connectors/kit";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Work this long, then leave the rest to the next tick. */
const BUDGET_MS = 200_000;
/** The most a page of rows may carry into the database. */
const PAGE = 500;

type HeldJob = Job & { id: string; provider: string; store_id: string };

/**
 * POST /api/connectors/worker — a store connection's sync, with nobody
 * watching (0204, docs/integrations/connectors.md).
 *
 * Called by the database, never by a person: abo_connector_dispatch posts
 * { connection, ticket } when a connection is due. The ticket is the
 * whole of this route's authority, checked by the database, which minted
 * it for one connection, keeps only its hash, and lets it reach that
 * connection's credential and rows until it lapses. As the import's
 * worker: no standing secret on this server, nothing a stolen request
 * could reuse for another store.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { connection?: unknown; ticket?: unknown } | null;
  const connection = typeof body?.connection === "string" ? body.connection : null;
  const ticket = typeof body?.ticket === "string" ? body.ticket : null;
  if (!connection || !ticket || ticket.length < 32 || ticket.length > 256) {
    return NextResponse.json({ error: "Not a sync job." }, { status: 400 });
  }
  const db = connectorTicketClient(ticket);
  const job = await heldJob(db);
  if (!job || job.id !== connection) {
    return NextResponse.json({ error: "No such sync job." }, { status: 401 });
  }
  // Where a provider that pushes posts to us: this deployment's own address.
  const hookBase = `${new URL(req.url).origin}/api/connectors/${job.provider}/hook/`;
  after(() => work(db, job, hookBase));
  return NextResponse.json({ accepted: true }, { status: 202 });
}

async function heldJob(db: SupabaseClient): Promise<HeldJob | null> {
  const { data, error } = await db.rpc("abo_connector_job");
  if (error) {
    console.error("connector worker: could not read its job:", error.message);
    return null;
  }
  const job = data as HeldJob | null;
  return job?.secret ? job : null;
}

async function work(db: SupabaseClient, job: HeldJob, hookBase: string) {
  const adapter = ADAPTERS[job.provider as keyof typeof ADAPTERS];
  try {
    if (!adapter) {
      await db.rpc("abo_connector_done", { p_next_minutes: 1440, p_error: `No adapter for ${job.provider} yet.` });
      return;
    }
    const io = {
      deadline: Date.now() + BUDGET_MS,
      putShipments: async (rows: ShipmentRow[]) => {
        for (let i = 0; i < rows.length; i += PAGE) {
          const { error } = await db.rpc("abo_connector_put_shipments", { p_rows: rows.slice(i, i + PAGE) });
          if (error) throw new Error(error.message);
        }
      },
      // Each list has its own writer (abo_connector_put_<list>), which takes only the lists this connection brings.
      put: async <L extends keyof ListRows>(list: L, rows: ListRows[L][]) => {
        for (let i = 0; i < rows.length; i += PAGE) {
          const { error } = await db.rpc(`abo_connector_put_${list}`, { p_rows: rows.slice(i, i + PAGE) });
          if (error) throw new Error(error.message);
        }
      },
      putCursor: async (resource: string, cursor: string | null, through?: string | null) => {
        const { error } = await db.rpc("abo_connector_put_cursor", {
          p_resource: resource,
          p_cursor: cursor,
          p_through: through ?? null,
        });
        if (error) throw new Error(error.message);
      },
      putSecret: async (secret: string) => {
        const { error } = await db.rpc("abo_connector_put_secret", { p_secret: secret });
        if (error) throw new Error(error.message);
      },
      hookBase,
      putHook: async (token: string) => {
        const { error } = await db.rpc("abo_connector_put_hook", { p_token: token });
        if (error) throw new Error(error.message);
      },
      carrierAwbs: async (carrier: string, limit: number) => {
        const { data, error } = await db.rpc("abo_connector_carrier_awbs", { p_carrier: carrier, p_limit: limit });
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{ awb: string; order_number: string | null }>;
      },
      openShipments: async (settled: string[], limit: number) => {
        const { data, error } = await db.rpc("abo_connector_open_shipments", { p_settled: settled, p_limit: limit });
        if (error) throw new Error(error.message);
        return (data ?? []) as string[];
      },
    };
    const { nextMinutes } = await adapter.sync(job, io);
    await db.rpc("abo_connector_done", { p_next_minutes: nextMinutes });
  } catch (e) {
    const said = e instanceof Error ? e.message : "The sync stopped.";
    // A refused login waits for the owner; a busy provider and an outage are tried again.
    const refused = e instanceof ConnectorRefused;
    const next = refused ? 1440 : e instanceof ConnectorBusy ? 15 : 30;
    if (!refused && !(e instanceof ConnectorBusy)) console.error(`connector worker ${job.provider}:`, said);
    await db.rpc("abo_connector_done", { p_next_minutes: next, p_error: said, p_refused: refused });
  } finally {
    const { error } = await db.rpc("abo_connector_release");
    if (error) console.error("connector worker: could not release its connection:", error.message);
  }
}
