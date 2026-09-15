import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import {
  dayRangeInZone,
  isStoreTable,
  listStores,
  lowStock,
  orderDetail,
  readStoreRows,
  searchOrders,
  storeOverview,
} from "@/lib/store-read";
import { blueprintAsText, runTurn } from "@/lib/engine";
import { describePlan } from "@/lib/describe";
import { applyPlans } from "@/lib/apply";
import type { AssistantPlan, ModuleRow, ProjectRow } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/mcp — the merchant's own assistant, reading their store.
 *
 * Streamable HTTP in its simplest honest form: every request gets one
 * JSON response, no SSE and no session. Both are optional in the spec,
 * and a server that keeps no state cannot lose any — nothing here
 * streams, so pretending to would be ceremony.
 *
 * Store data is read-only. The app itself can be changed, but only
 * along one path: propose_change designs it here — the assistant never
 * writes plans — and approve_change builds it once the merchant has
 * heard that design and said yes. The database enforces this; a token
 * carrying client_id cannot write anything else at all.
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
    name: "get_order",
    description:
      "One order in full, with the items in it. Use this when the merchant asks about a particular order; search_orders lists many and deliberately leaves the contents out.",
    inputSchema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          description: 'The order number, with or without the "#".',
        },
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
      },
      required: ["order_number"],
    },
  },
  {
    name: "search_store",
    description:
      "Look through the store's products, customers, orders or stock levels. Read-only, and it only sees what has been synced from Shopify.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: ["products", "customers", "orders", "inventory_levels"],
          description: "Which of the store's lists to look in.",
        },
        q: {
          type: "string",
          description:
            "Words to look for — a product title, a customer's name or email, an order number. Leave it out to list the most recent.",
        },
        limit: { type: "number", description: "Up to 200. Defaults to 25." },
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
      },
      required: ["table"],
    },
  },
  {
    name: "low_stock",
    description:
      "Products running out: every variant at or below a number, lowest first, with the location it is short at. Ask with threshold 0 for what is already out of stock.",
    inputSchema: {
      type: "object",
      properties: {
        threshold: { type: "number", description: "At or below this count. Defaults to 5." },
        limit: { type: "number", description: "Up to 100. Defaults to 50." },
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
      },
    },
  },
  {
    name: "read_section",
    description:
      "How a section in the merchant's Warmluke app is put together — its fields, its filters, its stats, where its rows come from — and its rows when it holds its own. Call it with no arguments to list the sections. Use this before guessing why something on screen behaves the way it does.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The section's name, as listed." },
        limit: { type: "number", description: "Up to 200. Defaults to 50." },
        project_id: { type: "string", description: "Which app, when they have more than one." },
      },
    },
  },
  {
    name: "propose_change",
    description:
      "Ask for something to be built or changed in the merchant's Warmluke app — a new section, a rule, a fix. Describe the problem in their own words, not a database design. Warmluke designs it and returns the plan; read that plan back to the merchant word for word and, if they approve, call approve_change. Nothing is built until then.",
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
  {
    name: "approve_change",
    description:
      "Build a design the merchant has just approved. Call this ONLY after reading the design from propose_change back to them and hearing them agree — it changes their live app. Pass the request_id propose_change returned.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The id propose_change returned." },
      },
      required: ["request_id"],
    },
  },
] as const;

/**
 * Removing a section takes every row in it and does not come back. In
 * the app the owner types the section's name to confirm; there is no
 * such moment in a chat window, so this never travels that way. The
 * database refuses it too — this is only so the answer is a sentence
 * rather than an error.
 */
const removals = (plans: AssistantPlan[]) =>
  plans.filter((p) => p.changeType === "MODULE_DELETE").map((p) => p.deleteConfirmName ?? "a section");

/**
 * How many designs an assistant may build unattended in a day.
 *
 * Not about cost — about waking up to a changed app. A merchant who
 * wanted ten new sections will ask again tomorrow; a client stuck in
 * a loop will not.
 */
const AUTO_BUILDS_PER_DAY = 5;

/** Change types that only ever add. Everything else waits. */
const ADDITIVE = new Set(["NEW_MODULE", "RECORD_SEED"]);

/**
 * Whether this design may be built without the merchant reading it,
 * and if not, the reason in words they can be told.
 *
 * The setting says they are willing in principle. This decides about
 * one design, because "yes, build things for me" is not the same as
 * "yes, rewrite the section my staff use" — and the engine's own
 * doubts are exactly the moments a person should be reading.
 */
function whyNotAutomatic(
  plans: AssistantPlan[],
  unmet: string[],
  modules: ModuleRow[],
  store: Parameters<typeof blueprintAsText>[2]
): string | null {
  if (plans.length === 0) return "there is nothing to build";

  const heavy = plans.find((p) => !ADDITIVE.has(p.changeType));
  if (heavy) {
    return `it changes something that already exists (${heavy.changeType}), and only additions are built automatically`;
  }
  if (unmet.length > 0) {
    return "part of what was asked for is not covered by this design, which is worth reading first";
  }
  // A warning is the engine saying "this may not be what you want" —
  // the duplicate-of-your-Shopify-data one, most often.
  const warned = plans.some((p) => (describePlan(p, modules, undefined, store).warnings ?? []).length > 0);
  if (warned) return "the design carries a warning worth reading first";

  return null;
}

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

  // Connecting an outside AI is the other switch. Refused here rather
  // than at the OAuth step so a merchant whose access is turned off
  // gets a sentence their assistant can read out, not a silent
  // failure to connect.
  const { data: mcpOn } = await db.rpc("abo_feature", { p_name: "mcp" });
  if (mcpOn === false) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "Outside AI access is turned off for this Warmluke account.",
        },
      },
      { status: 403 }
    );
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
        "One merchant's Warmluke app and connected Shopify store. Store data is read-only, and a day always means a day in the store's own timezone. Changes to their app go through propose_change, which returns a design, and approve_change, which builds it only after they have heard the design and agreed.",
    });
  }

  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  if (method !== "tools/call") {
    return rpcError(id, -32601, `No method "${method}".`);
  }

  const { name, arguments: args = {} } = params as { name?: string; arguments?: Json };

  // Counted before the work, not after: the point is to stop a client
  // in a loop, and a limiter that only notices once the reads have
  // happened has already paid for them. The same row is the record of
  // what the assistant asked for.
  const { data: allowance, error: callErr } = await db.rpc("abo_mcp_call", {
    p_tool: name ?? "?",
  });
  if (callErr) return rpcError(id, -32603, callErr.message);
  const allowed = allowance as { ok: boolean; used: number; limit: number } | null;
  if (allowed && !allowed.ok) {
    return ok(
      id,
      text({
        error: `This account has made ${allowed.limit} requests in the last hour, which is the limit.`,
        note: "Wait a little and try again. Nothing is broken.",
      })
    );
  }

  try {
    if (name === "propose_change") {
      const request = String(args.request ?? "").trim();
      if (!request) {
        return ok(id, text({ error: "Say what they want built." }));
      }
      // Which app. A merchant with one project should not be asked;
      // a merchant with several must not have one picked for them.
      const { data: projects } = await db.from("projects").select("*");
      const list = (projects ?? []) as ProjectRow[];
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

      const { data: modules } = await db
        .from("modules")
        .select("*")
        .eq("project_id", project.id)
        .order("sort_order", { ascending: true });
      const moduleList = (modules ?? []) as ModuleRow[];

      // The design is made here, by the same engine the app uses, from
      // the same gates. Claude supplies the sentence and nothing else —
      // letting it write plans would put every structural gate on the
      // wrong side of the fence.
      // The same counter as the chat box. Designing through their own
      // Claude still runs our engine on our key — a quota that only
      // watched the chat would have capped nothing.
      const { data: allowance } = await db.rpc("abo_spend_turn");
      const turns = allowance as
        | { ok: boolean; used: number; free: number; spend_id?: string }
        | null;
      if (turns && !turns.ok) {
        return ok(
          id,
          text({
            error: `This account has used all ${turns.free} free builds on Warmluke's assistant.`,
            note: "Reading their store still works — orders, stock, products, customers — and any design already waiting can still be approved. Building something new needs Warmluke AI.",
            open: `${new URL(req.url).origin}/app/${project.id}`,
          })
        );
      }

      const turn = await runTurn({
        client: db,
        project,
        modules: moduleList,
        message: request,
        // This tool cannot build. The design it hands back is the
        // showing, so plain plans are a perfectly good answer — in the
        // chat they would mean building before anyone had seen a plan.
        plansAllowed: true,
        signal: req.signal,
      });
      if (!turn.ok) {
        await db.rpc("abo_refund_turn", { p_spend: turns?.spend_id ?? null });
        return ok(
          id,
          text({
            error: "Warmluke could not turn that into a design it trusts.",
            detail: turn.errors.slice(0, 3),
            note: "Say it again with more about how they actually work, and what should happen when.",
          })
        );
      }

      // Questions come back unanswered rather than guessed at. The
      // merchant is already in this conversation, so they answer here
      // and the request comes back complete — no trip to the app to
      // fill in what could have been asked out loud.
      if (turn.reply.type === "clarify") {
        return ok(
          id,
          text({
            status: "needs answers",
            note: "Nothing has been requested yet. Ask the merchant these, then call propose_change again with their answers included.",
            message: turn.reply.message,
            questions: turn.reply.questions,
          })
        );
      }

      const design = blueprintAsText(turn.reply, moduleList, turn.store, turn.unmet);
      const plans =
        turn.reply.type === "blueprint" ? turn.reply.blueprint.plans : turn.reply.plans;

      // ── Does this one get to skip the merchant? ──────────────
      //
      // The switch says they are willing; this decides whether THIS
      // design qualifies. Additive only, nothing the engine flagged,
      // and a ceiling per day — a client in a loop must not be able
      // to build fifty sections overnight.
      const autoReason = whyNotAutomatic(plans, turn.unmet, moduleList, turn.store);
      const wantsAuto = project.auto_build === true;

      const gone = removals(plans);
      if (gone.length) {
        return ok(
          id,
          text({
            error: "Removing a section cannot be done from here.",
            note: `Tell the merchant to open Warmluke, choose the section, and type its name (${gone.join(", ")}) to confirm. Nothing has been requested or changed.`,
            open: `${new URL(req.url).origin}/app/${project.id}`,
          })
        );
      }

      let automatic = wantsAuto && autoReason === null;
      if (automatic) {
        // Counted before building, so a loop pays for its own stop.
        const since = new Date(Date.now() - 864e5).toISOString();
        const { count } = await db
          .from("build_requests")
          .select("id", { count: "exact", head: true })
          .eq("project_id", project.id)
          .eq("auto_built", true)
          .gt("built_at", since);
        if ((count ?? 0) >= AUTO_BUILDS_PER_DAY) automatic = false;
      }

      const { data: requestId, error: err } = await db.rpc("abo_mcp_propose", {
        p_project: project.id,
        p_request: request,
        p_plans: plans,
        p_summary: design,
        // Stored apart from the rendered text because the card keeps
        // this visible while the details fold away: everything else
        // can be rebuilt from the plans, this cannot.
        p_unmet: turn.unmet,
      });
      if (err) return ok(id, text({ error: err.message }));

      const origin = new URL(req.url).origin;

      if (automatic) {
        // auto-build IS the approval — given in Warmluke, on this
        // project, before any of this was asked for. The stamp records
        // that, so the row says who agreed and when.
        await db.rpc("abo_approve_request", { p_request: requestId });
        const { applied, errors } = await applyPlans(db, project.id, plans, requestId as string);
        if (applied.length > 0) {
          await db.rpc("abo_build", {
            p_project: project.id,
            p_request: requestId,
            p_op: "request_built",
            p_payload: {},
          });
          await db.from("build_requests").update({ auto_built: true }).eq("id", requestId);
          return ok(
            id,
            text({
              status: errors.length ? "partly built" : "built",
              note: "This app builds additive changes without waiting. Tell the merchant what was built — it is already live and shows in their panel.",
              built: applied,
              ...(errors.length ? { not_built: errors.slice(0, 3) } : {}),
              design,
              open: `${origin}/app/${project.id}`,
            })
          );
        }
        // Nothing applied. It stays a request for a person to look at
        // rather than being reported as done.
      }

      return ok(
        id,
        text({
          // Said plainly so the model reports it plainly: nothing has
          // been built, and somebody still has to say yes.
          status: "waiting for approval",
          note: "Nothing has changed yet. Read this design back to the merchant word for word. If they approve, call approve_change with the request_id.",
          request_id: requestId,
          design,
          // When the merchant has asked for automatic builds, say why
          // this one still needs them. Otherwise they are left
          // wondering why the setting did nothing.
          ...(wantsAuto && autoReason ? { not_automatic_because: autoReason } : {}),
          open: `${origin}/app/${project.id}`,
        })
      );
    }

    if (name === "read_section") {
      // Their own app, not their Shopify data — so this runs before
      // the store lookup below. An account with no store still has
      // sections, and refusing here would be answering a different
      // question than the one asked.
      const { data: projects } = await db.from("projects").select("id, name");
      const list = projects ?? [];
      const wanted = (args.project_id as string | undefined)?.trim();
      const project = wanted
        ? list.find((p) => p.id === wanted)
        : list.length === 1
          ? list[0]
          : null;
      if (!project) {
        return ok(
          id,
          text({
            error: list.length ? "Which app? Pass project_id." : "This account has no app yet.",
            projects: list.map((p) => ({ id: p.id, name: p.name })),
          })
        );
      }

      const { data: modules } = await db
        .from("modules")
        .select("id, name, nav_label, source_table")
        .eq("project_id", project.id)
        .order("sort_order", { ascending: true });
      const sections = (modules ?? []) as Array<{
        id: string;
        name: string;
        nav_label: string;
        source_table: string | null;
      }>;

      const asked = (args.section as string | undefined)?.trim().toLowerCase();
      if (!asked) {
        return ok(
          id,
          text({
            sections: sections.map((m) => ({
              section: m.nav_label,
              // Saying where the rows come from stops the assistant
              // reading a Shopify-backed section twice — once here and
              // once through search_store — and reporting two numbers.
              rows_from: m.source_table ? `Shopify ${m.source_table}` : "this app",
            })),
            note: sections.length
              ? "Call again with one of these as `section`."
              : "Nothing has been built in this app yet.",
          })
        );
      }

      const section =
        sections.find((m) => m.nav_label.toLowerCase() === asked) ??
        sections.find((m) => m.name.toLowerCase() === asked) ??
        sections.find((m) => m.nav_label.toLowerCase().includes(asked));
      if (!section) {
        return ok(
          id,
          text({
            error: `No section called "${args.section}".`,
            sections: sections.map((m) => m.nav_label),
          })
        );
      }

      // How the section is put together, whoever owns its rows. An
      // assistant asked "the dropdown does not work" could not look
      // at the dropdown: it could read rows and nothing else, so it
      // had to guess, and it guessed that nothing had been built.
      const { data: schemaRow } = await db
        .from("ui_schemas")
        .select("schema_json, version")
        .eq("module_id", section.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const sj = (schemaRow?.schema_json ?? {}) as {
        columns?: Array<{ field: string; label: string; type: string }>;
        features?: Record<string, unknown> | null;
      };
      const setup = {
        section: section.nav_label,
        rows_from: section.source_table ? `Shopify ${section.source_table}` : "this app",
        version: schemaRow?.version ?? null,
        fields: (sj.columns ?? []).map((c) => ({ field: c.field, label: c.label, type: c.type })),
        features: sj.features ?? null,
      };

      if (section.source_table) {
        return ok(
          id,
          text({
            ...setup,
            note: `Its rows are the store's ${section.source_table} — read them with search_store, table "${section.source_table}".`,
          })
        );
      }

      const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);
      const { data: rows, count } = await db
        .from("records")
        .select("data", { count: "exact" })
        .eq("module_id", section.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      return ok(
        id,
        text({
          ...setup,
          total: count ?? 0,
          showing: rows?.length ?? 0,
          rows: (rows ?? []).map((r) => r.data),
        })
      );
    }

    if (name === "approve_change") {
      const requestId = String(args.request_id ?? "").trim();
      if (!requestId) return ok(id, text({ error: "Which request? Pass request_id." }));

      // RLS already limits this to the merchant's own requests.
      const { data: rows } = await db
        .from("build_requests")
        .select("id, project_id, request, plans, summary, status")
        .eq("id", requestId)
        .limit(1);
      const reqRow = rows?.[0] as
        | { id: string; project_id: string; request: string; plans: AssistantPlan[] | null; summary: string | null; status: string }
        | undefined;
      if (!reqRow) return ok(id, text({ error: "No such request on this account." }));
      if (reqRow.status === "built") {
        return ok(id, text({ status: "already built", note: "This design was already applied. Nothing was built again." }));
      }
      if (reqRow.status === "opened") {
        return ok(
          id,
          text({
            error: "The merchant already opened this in Warmluke and is designing it there.",
            note: "Leave it to them rather than building a second copy.",
          })
        );
      }
      if (reqRow.status === "dismissed") {
        return ok(id, text({ error: "The merchant dismissed this request. Propose it again if they changed their mind." }));
      }
      if (!reqRow.plans?.length) {
        return ok(
          id,
          text({
            error: "This request has no design attached — it predates approval from here.",
            note: "Call propose_change again with the same words to get one.",
          })
        );
      }

      const goneNow = removals(reqRow.plans);
      if (goneNow.length) {
        return ok(
          id,
          text({
            error: "This design removes a section, which cannot be built from here.",
            note: `In Warmluke, open the section and type its name (${goneNow.join(", ")}) to confirm. Nothing has changed.`,
          })
        );
      }

      // Record the yes before anything is written. The database no
      // longer takes a client's word for it: with auto-build on this
      // stamps, and with it off it refuses and the design waits for
      // the merchant in Warmluke — where the bell already shows it.
      const { data: nod } = await db.rpc("abo_approve_request", { p_request: reqRow.id });
      const approval = nod as { approved: boolean; reason?: string } | null;
      if (!approval?.approved) {
        return ok(
          id,
          text({
            status: "waiting for approval",
            error:
              "Warmluke needs the merchant's yes from inside their own app before this is built.",
            note: "Tell them it is waiting in Warmluke — the bell in the assistant panel. If they would rather you built these without asking each time, they can turn auto-build on for this app.",
            open: `${new URL(req.url).origin}/app/${reqRow.project_id}`,
            reason: approval?.reason,
          })
        );
      }

      // Claim it first. Two assistants approving at once would
      // otherwise both build, and the merchant would get the section
      // twice.
      const { data: claim, error: claimErr } = await db.rpc("abo_build", {
        p_project: reqRow.project_id,
        p_request: reqRow.id,
        p_op: "request_claim",
        p_payload: {},
      });
      if (claimErr) return ok(id, text({ error: claimErr.message }));
      if (Number((claim as { count?: number } | null)?.count ?? 0) === 0) {
        return ok(id, text({ status: "already being built", note: "Somebody is applying this right now." }));
      }

      const { applied, errors } = await applyPlans(db, reqRow.project_id, reqRow.plans, reqRow.id);

      if (applied.length === 0) {
        await db.rpc("abo_build", {
          p_project: reqRow.project_id,
          p_request: reqRow.id,
          p_op: "request_release",
          p_payload: {},
        });
        return ok(id, text({ status: "not built", errors: errors.slice(0, 3) }));
      }

      await db.rpc("abo_build", {
        p_project: reqRow.project_id,
        p_request: reqRow.id,
        p_op: "request_built",
        p_payload: {},
      });

      const origin = new URL(req.url).origin;
      // A partial build is said out loud. Reporting only the parts
      // that worked would hand the merchant half a feature and no sign
      // that the rest is missing.
      return ok(
        id,
        text({
          status: errors.length ? "partly built" : "built",
          built: applied,
          ...(errors.length ? { not_built: errors.slice(0, 3) } : {}),
          note: errors.length
            ? "Some of it went in and some did not. Tell the merchant exactly which, and what is still missing."
            : "It is live in their app now.",
          open: `${origin}/app/${reqRow.project_id}`,
        })
      );
    }

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

    if (name === "get_order") {
      const ref = String(args.order_number ?? "").trim();
      if (!ref) return ok(id, text({ error: "Which order? Pass order_number." }));
      const order = await orderDetail(db, store.id, ref);
      if (!order) {
        return ok(
          id,
          text({
            error: `No order ${ref} in ${store.shop_domain}.`,
            // Said plainly, because "not found" on a store that is
            // still importing means "not yet", and answering "you
            // have no such order" would be wrong.
            note: "If the store is still importing, it may not have arrived yet.",
          })
        );
      }
      return ok(id, text({ ...order, currency: order.currency ?? store.currency }));
    }

    if (name === "search_store") {
      const table = String(args.table ?? "");
      if (!isStoreTable(table)) {
        return ok(
          id,
          text({
            error: `"${table}" is not one of the store's lists.`,
            available: ["products", "customers", "orders", "inventory_levels"],
          })
        );
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 200);
      const { rows, total } = await readStoreRows(
        db,
        store.id,
        table,
        limit,
        args.q as string | undefined
      );
      return ok(
        id,
        text({
          table,
          // Both numbers, always: "12 rows" out of 4,000 read as an
          // answer about the whole store otherwise.
          matched: total,
          showing: rows.length,
          currency: store.currency,
          rows: rows.map((r) => r.data),
        })
      );
    }

    if (name === "low_stock") {
      const threshold = Number(args.threshold ?? 5);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return ok(id, text({ error: "threshold must be a number, 0 or more." }));
      }
      const rows = await lowStock(db, store.id, {
        threshold,
        limit: Number(args.limit ?? 50) || 50,
      });
      return ok(
        id,
        text({
          threshold,
          count: rows.length,
          note:
            rows.length === 0
              ? `Nothing is at or below ${threshold}.`
              : "Counts are as of the last sync from Shopify.",
          rows,
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
