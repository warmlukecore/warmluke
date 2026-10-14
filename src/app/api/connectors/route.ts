import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { connectorById } from "@/lib/connectors";
import { ADAPTERS } from "@/lib/connectors/adapters";
import { ConnectorBusy, ConnectorRefused } from "@/lib/connectors/kit";

export const runtime = "nodejs";

/**
 * The owner's connections (0204, docs/integrations/connectors.md).
 *
 *   POST   { storeId, provider, fields }  connect: the login is proved with
 *          the provider here, then kept in the vault (abo_connector_save)
 *   PATCH  { connectionId }               sync now (abo_connector_kick)
 *   DELETE { connectionId }               disconnect (abo_connector_disconnect)
 *
 * The database decides who may: the owner, in Warmluke, never from their
 * AI's token. This route checks the owner once more before it sends a
 * login anywhere, so it is never a way to try passwords against a
 * provider on somebody else's store. The connections themselves are
 * read straight from store_connections, under its policy.
 *
 * Callers: src/components/ConnectionsSettings.tsx.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    storeId?: unknown;
    provider?: unknown;
    fields?: unknown;
  } | null;
  const storeId = typeof body?.storeId === "string" ? body.storeId : null;
  const connector = typeof body?.provider === "string" ? connectorById(body.provider) : undefined;
  const fields =
    body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
      ? Object.fromEntries(
          Object.entries(body.fields as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            // A key file (Google's service account, ~2.3k) is the longest a provider asks for.
            .map(([k, v]) => [k, (v as string).slice(0, 8000)])
        )
      : null;
  if (!storeId || !connector || !fields) {
    return NextResponse.json({ error: "Which store, which provider, and its login." }, { status: 400 });
  }
  const adapter = ADAPTERS[connector.id as keyof typeof ADAPTERS];
  if (connector.ready !== true || connector.auth.kind !== "login" || !adapter) {
    return NextResponse.json({ error: `${connector.label} cannot be connected yet.` }, { status: 400 });
  }

  // The owner, before any login leaves this server.
  const { data: store } = await auth.client
    .from("stores")
    .select("id, project_id, projects(owner_id)")
    .eq("id", storeId)
    .eq("status", "connected")
    .maybeSingle();
  const owner = (store?.projects as { owner_id?: string } | { owner_id?: string }[] | null) ?? null;
  const ownerId = Array.isArray(owner) ? owner[0]?.owner_id : owner?.owner_id;
  if (!store || ownerId !== auth.userId) {
    return NextResponse.json({ error: "Only the store's owner connects it." }, { status: 403 });
  }

  let proved: { accountRef: string; accountLabel: string; secret: string };
  try {
    proved = await adapter.login(fields);
  } catch (e) {
    if (e instanceof ConnectorRefused) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ConnectorBusy) {
      return NextResponse.json(
        { error: `${connector.label} asked us to wait. Try again in a minute.` },
        { status: 429 }
      );
    }
    console.error(`connect ${connector.id}:`, e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: `${connector.label} could not be reached. Try again in a minute.` },
      { status: 502 }
    );
  }
  const { data: id, error } = await auth.client.rpc("abo_connector_save", {
    p_store: storeId,
    p_provider: connector.id,
    p_account_ref: proved.accountRef,
    p_account_label: proved.accountLabel,
    p_secret: proved.secret,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "42501" ? 403 : 400 });
  return NextResponse.json({ id });
}

export async function PATCH(req: Request) {
  return connection(req, "abo_connector_kick");
}

export async function DELETE(req: Request) {
  return connection(req, "abo_connector_disconnect");
}

async function connection(req: Request, fn: "abo_connector_kick" | "abo_connector_disconnect") {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { connectionId?: unknown } | null;
  const id = typeof body?.connectionId === "string" ? body.connectionId : null;
  if (!id) return NextResponse.json({ error: "Which connection." }, { status: 400 });
  const { data, error } = await auth.client.rpc(fn, { p_connection: id });
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "42501" ? 403 : 400 });
  return NextResponse.json({ ok: true, said: data });
}
