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
  {
    name: "propose_change",
    description:
      "Ask for something to be built or changed in the merchant's Warmluke app — a new section, a rule, a fix. Describe the problem in their own words; the design is made in Warmluke and shown to them for approval, so nothing changes until they say yes. Use this instead of claiming a change was made.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "What the merchant wants, in plain words. Say the problem and how they work, not a database design.",
        },
        project_id: {
          type: "string",
          description: "Which app, when they have more than one. Optional.",
        },
      },
      required: ["request"],
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

  // The whole endpoint is protected, not just the tools. Letting
  // initialize and tools/list through unauthenticated seemed friendlier
  // — a client could see what this server is before asking anyone to
  // sign in — but a real client reads that as "no sign-in needed" and
  // connects as an open server. Claude said exactly that.
  const auth = await getUserClient(req);
  if (!auth) {
    const meta = `${new URL(req.url).origin}/.well-known/oauth-protected-resource`;
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Sign in to use this server." } },
      {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${meta}"` },
      }
    );
  }
  const db = auth.client;

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

    if (name === "propose_change") {
      const request = String(args.request ?? "").trim();
      if (!request) {
        return ok(id, text({ error: "Say what they want built." }));
      }
      // Which app. A merchant with one project should not be asked;
      // a merchant with several must not have one picked for them.
      const { data: projects } = await db.from("projects").select("id, name");
      const list = projects ?? [];
      const wantedProject = (args.project_id as string | undefined)?.trim();
      const project = wantedProject
        ? list.find((p) => p.id === wantedProject)
        : list.length === 1
          ? list[0]
          : null;
      if (!project) {
        return ok(
          id,
          text({
            error: list.length
              ? "Which app is this for? Pass project_id."
              : "This account has no app yet.",
            projects: list.map((p) => ({ id: p.id, name: p.name })),
          })
        );
      }

      const { data: requestId, error: err } = await db.rpc("abo_mcp_propose", {
        p_project: project.id,
        p_request: request,
      });
      if (err) return ok(id, text({ error: err.message }));

      const origin = new URL(req.url).origin;
      return ok(
        id,
        text({
          // Said plainly so the model reports it plainly: nothing has
          // been built, and the merchant has to look.
          status: "waiting for the merchant",
          note: "Nothing has changed yet. Warmluke will design this and show them a plan to approve.",
          request_id: requestId,
          open: `${origin}/app/${project.id}`,
        })
      );
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
