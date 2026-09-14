import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { dayRangeInZone, listStores, searchOrders, storeOverview } from "@/lib/store-read";

export const runtime = "nodejs";

/**
 * POST /api/mcp — the merchant's own assistant, reading their store.
 *
 * Streamable HTTP in its simplest honest form: every request gets one
 * JSON response, no SSE and no session. Both are optional in the spec,
 * and a server that keeps no state cannot lose any — nothing here
 * streams, so pretending to would be ceremony.
 *
 * Read-only on purpose. A tool that could change a merchant's data from
 * a sentence typed into a chat window is a different product with a
 * different conversation about consent.
 */

/**
 * The newest revision this server has been written against. Every
 * revision since 2024-11-05 leaves the four methods used here
 * unchanged, which is why a newer client is welcome rather than
 * refused.
 */
const LATEST_KNOWN = "2025-11-25";
const KNOWN = new Set([LATEST_KNOWN, "2025-06-18", "2025-03-26", "2024-11-05"]);

/** A revision is a date. Anything else is a client with a bug. */
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

type Json = Record<string, unknown>;
type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Json };

const TOOLS = [
  {
    name: "store_overview",
    description:
      "What is in the merchant's connected Shopify store: the shop domain, its timezone and currency, when it last synced, and how many products, customers and orders are held.",
    inputSchema: {
      type: "object",
      properties: {
        shop_domain: {
          type: "string",
          description: "Which store, when the account has more than one. Optional.",
        },
      },
    },
  },
  {
    name: "search_orders",
    description:
      "Find orders in the connected store. A day is read in the store's own timezone, not the caller's — asking for yesterday in New York and getting UTC's yesterday would be a wrong answer.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "string", description: "A single calendar day, YYYY-MM-DD." },
        from: { type: "string", description: "ISO 8601 instant, inclusive." },
        to: { type: "string", description: "ISO 8601 instant, exclusive." },
        status: {
          type: "string",
          description: '"cancelled", or a Shopify financial or fulfilment status such as "paid".',
        },
        q: { type: "string", description: "An order number, or a customer's phone, email or name." },
        limit: { type: "number", description: "Up to 100. Defaults to 20." },
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
      },
    },
  },
] as const;

const ok = (id: RpcRequest["id"], result: Json) => NextResponse.json({ jsonrpc: "2.0", id, result });

const rpcError = (id: RpcRequest["id"], code: number, message: string) =>
  NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });

/** A tool's answer, as MCP wants it: text the model can read. */
const text = (value: unknown): Json => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export async function POST(req: Request) {
  // Required by the spec: without it a page on another origin could
  // drive an MCP server through someone's browser.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  }

  // Only a malformed version is refused, not an unfamiliar one. The
  // spec negotiates in the initialize body, so on the first request
  // there is nothing negotiated to check against — and rejecting every
  // revision newer than a hardcoded list locks out each new client as
  // it ships. That is exactly what happened: Claude sends 2025-11-25
  // and got a 400 before it could say hello.
  const version = req.headers.get("mcp-protocol-version");
  if (version && !VERSION_SHAPE.test(version)) {
    return NextResponse.json({ error: `"${version}" is not an MCP version.` }, { status: 400 });
  }

  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, "That was not JSON.");
  }

  // A notification or a response carries no id and expects no answer.
  if (body?.id === undefined || body?.id === null) {
    return new NextResponse(null, { status: 202 });
  }

  const { id, method, params = {} } = body;

  if (method === "initialize") {
    // Negotiation proper: speak the client's revision when it is one we
    // were written against, otherwise name ours and let it decide.
    const asked = (params as { protocolVersion?: string }).protocolVersion;
    return ok(id, {
      protocolVersion: asked && KNOWN.has(asked) ? asked : LATEST_KNOWN,
      capabilities: { tools: {} },
      serverInfo: { name: "warmluke", version: "0.1.0" },
      instructions:
        "Reads one merchant's connected Shopify store. Everything here is read-only, and a day always means a day in the store's own timezone.",
    });
  }

  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  if (method !== "tools/call") {
    return rpcError(id, -32601, `No method "${method}".`);
  }

  // Checked here rather than at the top: initialize and tools/list tell
  // a client what this server is, which it needs before it can ask the
  // merchant to sign in.
  const auth = await getUserClient(req);
  if (!auth) {
    const meta = `${new URL(req.url).origin}/.well-known/oauth-protected-resource`;
    return NextResponse.json(
      { jsonrpc: "2.0", id, error: { code: -32001, message: "Not signed in." } },
      {
        // A 401 is what makes a client offer to sign in rather than
        // report the tool as broken, and resource_metadata is how it
        // finds out where to sign in. Without the pointer the client
        // knows it is unauthorised and nothing else.
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${meta}"` },
      }
    );
  }
  const db = auth.client;

  const { name, arguments: args = {} } = params as { name?: string; arguments?: Json };

  try {
    // RLS decides which stores exist for this caller, so an account
    // with none gets an answer saying so rather than an empty list that
    // reads as "you have no orders".
    const stores = await listStores(db);
    if (stores.length === 0) {
      return ok(id, text({ error: "No Shopify store is connected to this account yet." }));
    }
    const wanted = (args.shop_domain as string | undefined)?.trim().toLowerCase();
    const store = wanted ? stores.find((s) => s.shop_domain === wanted) : stores[0];
    if (!store) {
      return ok(
        id,
        text({
          error: `No connected store called "${wanted}".`,
          available: stores.map((s) => s.shop_domain),
        })
      );
    }

    if (name === "store_overview") {
      return ok(id, text(await storeOverview(db, store.id)));
    }

    if (name === "search_orders") {
      const day = args.day as string | undefined;
      // Refused rather than guessed at: a malformed day quietly ignored
      // would answer about every order ever placed.
      if (day) {
        try {
          dayRangeInZone(day, store.timezone);
        } catch {
          return ok(id, text({ error: `"${day}" is not a date. Use YYYY-MM-DD.` }));
        }
      }
      const hits = await searchOrders(db, store, {
        day,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        status: args.status as string | undefined,
        q: args.q as string | undefined,
        limit: args.limit as number | undefined,
      });
      return ok(
        id,
        text({
          shop: store.shop_domain,
          timezone: store.timezone,
          currency: store.currency,
          count: hits.length,
          orders: hits,
        })
      );
    }

    return rpcError(id, -32602, `No tool called "${name}".`);
  } catch (e) {
    // Reported as a tool failure, not a protocol error: the call was
    // well formed, and the client should show the merchant what broke.
    return ok(id, {
      ...text({ error: e instanceof Error ? e.message : "The tool failed." }),
      isError: true,
    });
  }
}

/** No server-initiated stream here, which the spec says to say plainly. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

/** Nothing to terminate: this server keeps no session. */
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
