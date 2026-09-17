import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  storeTableSchema,
} from "@/lib/store-read";
import { blueprintAsText, runTurn, schemasFor } from "@/lib/engine";
import { PLAN_FORMAT, WORKED_EXAMPLE, parseReply } from "@/lib/ai";
import { vocabularyPrompt } from "@/lib/capabilities";
import { describePlan, describeRules, type RuleRow } from "@/lib/describe";
import { applyPlans, logClientBuild } from "@/lib/apply";
import { ALLOWED_ICONS } from "@/lib/types";
import type { AssistantPlan, ModuleRow, ProjectRow, UiSchema } from "@/lib/types";

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
    name: "pending_changes",
    description:
      "Designs that are actually waiting for the merchant's approval right now, with the request_id approve_change needs. Call this before telling them anything is waiting — a design they dismissed, or built in Warmluke, is no longer waiting, and there is no way to know that from memory.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Which app, when they have more than one. Optional.",
        },
      },
    },
  },
  {
    name: "build_history",
    description:
      "What has actually been built in this app, newest first — including the ones that only partly worked, and what did not. Use it to answer \"what changed last week?\", to check whether something was already done before proposing it again, and to see whether an earlier build left anything unfinished.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Which app, when they have more than one. Optional.",
        },
        limit: {
          type: "number",
          description: "How many to return, 1 to 50. Default 20.",
        },
        before: {
          type: "string",
          description:
            "An ISO instant. Returns only requests raised before it — pass the `next_before` from the last answer to keep going back.",
        },
      },
    },
  },
  {
    name: "reject_change",
    description:
      "Record that the merchant said no to a design. Call this when you read a waiting design back to them and they turn it down — otherwise it keeps sitting in their queue and their app keeps telling them it needs an answer. You may only refuse a request you raised.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description: "The id from pending_changes or propose_change.",
        },
        reason: {
          type: "string",
          description:
            "Why, in the merchant's own words. Kept with the request so they recognise the decision later. Optional.",
        },
      },
      required: ["request_id"],
    },
  },
  {
    name: "design_format",
    description:
      "Everything you need to write a design yourself instead of asking Warmluke to write it: the column types, view types, rule triggers and actions this platform has, the expression operators, and the shape of a plan. Read this before calling submit_design. Designing here costs the merchant nothing — you are the one doing the thinking, on their own subscription.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "validate_design",
    description:
      "Check a design without sending it anywhere. Returns the same list of problems submit_design would return, or confirms it holds — but nothing is requested, nothing reaches the merchant and nothing is changed. Use it while you are still writing: it is cheaper to be told the shape is wrong here than to put a half-right design in front of somebody.",
    inputSchema: {
      type: "object",
      properties: {
        plans: {
          type: "array",
          description: "The plans to check, in the shape design_format describes.",
          items: { type: "object" },
        },
        project_id: {
          type: "string",
          description: "Which app, when they have more than one. Optional.",
        },
      },
      required: ["plans"],
    },
  },
  {
    name: "submit_design",
    description:
      "Submit a design you wrote yourself. Warmluke checks it against the same validator its own engine answers to and, if it holds, puts it in front of the merchant for approval exactly like propose_change does. Rejections come back as a list of what is wrong, so you can correct it and submit again. Unlike propose_change this runs no Warmluke model, so it does not use one of the merchant's included designs — use it when they have run out, or whenever you would rather design it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        plans: {
          type: "array",
          description:
            "The plans, in the shape design_format describes. This is the same array propose_change would have produced.",
          items: { type: "object" },
        },
        request: {
          type: "string",
          description:
            "What the merchant asked for, in their own words. Shown on the approval card so they recognise what they asked for.",
        },
        project_id: {
          type: "string",
          description: "Which app, when they have more than one. Optional.",
        },
      },
      required: ["plans"],
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
// What may be built without the merchant reading it first.
//
// The line is not how visible the change is — a whole new section
// appears in the sidebar unasked and has always been on this list. It
// is whether anything can be lost. FIELD_ADD cannot: the validator
// refuses it unless every existing column survives, in its existing
// order, with at least one new one appended. Leaving it off while
// NEW_MODULE was on was an inconsistency, not a safeguard.
//
// Everything else still waits, because it edits what is already
// there — or, for AUTOMATION_ADD, starts something that writes to
// rows on its own afterwards.
const ADDITIVE = new Set(["NEW_MODULE", "RECORD_SEED", "FIELD_ADD"]);

/** What went in, in the words the panel already uses for a build. */
function builtLine(
  plans: AssistantPlan[],
  modules: ModuleRow[],
  errors: string[]
): string {
  const titles = plans.map((p) => describePlan(p, modules).title).filter(Boolean);
  const shown = titles.slice(0, 3).join(" · ");
  const rest = titles.length - 3;
  const head = `✅ ${shown}${rest > 0 ? ` · and ${rest} more` : ""}`;
  return errors.length ? `${head} — the rest stopped on an error.` : `${head}.`;
}

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

/**
 * The rules on a project, or on one section of it.
 *
 * RLS scopes these to the caller. A section's rules and the app's own
 * are the same question asked twice, so they are the same query.
 */
const ruleRowsFor = async (db: SupabaseClient, projectId: string, moduleId: string | null) => {
  let q = db
    .from("automations")
    .select("id, name, enabled, module_id, definition")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .limit(40);
  q = moduleId === null ? q.is("module_id", null) : q.eq("module_id", moduleId);
  const { data } = await q;
  return data ?? [];
};

/**
 * One request, as the assistant reads it.
 *
 * pending_changes and build_history ask the same table two different
 * questions, and a row that means one thing in one answer and another
 * thing in the other is how the last three of these bugs happened.
 */
type RequestRow = {
  id: string;
  project_id: string;
  request: string;
  summary: string | null;
  status: string;
  approved_at: string | null;
  created_at: string;
  built_at?: string | null;
  client_id: string | null;
  outcome: { applied?: unknown[]; errors?: string[] } | null;
};

const shapeRequest = (r: RequestRow, client: string | null) => {
  const state =
    r.status === "partly_built"
      ? "partly built"
      : r.status === "built"
        ? "built"
        : r.status === "dismissed"
          ? "dismissed"
          : r.status === "opened"
            ? "the merchant took it over in Warmluke"
            : r.status === "building"
              ? "building"
              : r.approved_at
                ? "approved, not built yet"
                : "awaiting_approval";
  return {
    request_id: r.id,
    project_id: r.project_id,
    asked_for: r.request,
    design: r.summary,
    state,
    raised_by: !r.client_id
      ? "the merchant, in Warmluke"
      : r.client_id === client
        ? "this assistant"
        : "another assistant connected to this account",
    // Two things have to hold, and only one of them used to be
    // checked. The client that raised it may build it — the database
    // enforces that — but so must the request still be approvable at
    // all. A finished, dismissed or taken-over one came back as yours
    // to approve, which is an id the model cannot act on.
    you_can_approve_it:
      (r.status === "pending" || r.status === "building") &&
      (client === null || r.client_id === client),
    ...(r.outcome
      ? {
          built: r.outcome.applied ?? [],
          did_not_build: (r.outcome.errors ?? []).slice(0, 3),
        }
      : {}),
    since: r.created_at,
    ...(r.built_at ? { finished: r.built_at } : {}),
  };
};

/** How many waiting designs one answer names before it says so. */
const SHOW_WAITING = 20;

/** The connected client this request came from, or null for the app. */
const clientIdOf = (req: Request): string | null => {
  const raw = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const body = raw.split(".")[1];
  if (!body) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      client_id?: string;
    };
    return claims.client_id || null;
  } catch {
    // An unreadable token is not a client. Everything it could reach is
    // already decided by RLS on the same token, so reading none of it
    // here costs nothing.
    return null;
  }
};

const ok = (id: RpcRequest["id"], result: Json) => NextResponse.json({ jsonrpc: "2.0", id, result });

const rpcError = (id: RpcRequest["id"], code: number, message: string) =>
  NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });

/** A tool's answer, as MCP wants it: text the model can read. */
const text = (value: unknown): Json => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/**
 * What happens to a design once there is one: stored, shown, and built
 * only if the merchant already said it could be.
 *
 * Both doors end here — the one where Warmluke does the designing, and
 * the one where the merchant's own assistant does. They must agree
 * about approval and about the daily ceiling, and the only way to be
 * sure of that is for there to be one copy of it.
 */
async function settleDesign(opts: {
  db: SupabaseClient;
  id: RpcRequest["id"];
  origin: string;
  project: ProjectRow;
  moduleList: ModuleRow[];
  plans: AssistantPlan[];
  design: string | null;
  unmet: string[];
  request: string;
  store: Parameters<typeof whyNotAutomatic>[3];
}) {
  const { db, id, origin, project, moduleList, plans, design, unmet, request, store } = opts;

      // ── Does this one get to skip the merchant? ──────────────
      //
      // The switch says they are willing; this decides whether THIS
      // design qualifies. Additive only, nothing the engine flagged,
      // and a ceiling per day — a client in a loop must not be able
      // to build fifty sections overnight.
      const autoReason = whyNotAutomatic(plans, unmet, moduleList, store);
      const wantsAuto = project.auto_build === true;

      const gone = removals(plans);
      if (gone.length) {
        return ok(
          id,
          text({
            error: "Removing a section cannot be done from here.",
            note: `Tell the merchant to open Warmluke, choose the section, and type its name (${gone.join(", ")}) to confirm. Nothing has been requested or changed.`,
            open: `${origin}/app/${project.id}`,
          })
        );
      }

      let automatic = wantsAuto && autoReason === null;
      // Why an automatic build did not happen, when it was meant to.
      let autoFailed: string[] = [];
      let ceilingHit = false;
      if (automatic) {
        // Counted before building, so a loop pays for its own stop.
        const since = new Date(Date.now() - 864e5).toISOString();
        const { count } = await db
          .from("build_requests")
          .select("id", { count: "exact", head: true })
          .eq("project_id", project.id)
          .eq("auto_built", true)
          .gt("built_at", since);
        if ((count ?? 0) >= AUTO_BUILDS_PER_DAY) {
          automatic = false;
          // Said out loud. The design qualified and nothing failed, so
          // neither of the other two reasons fires — a merchant with
          // the switch on simply saw it stop working for the rest of
          // the day with no explanation anywhere. Same silence that
          // used to hide a failed apply, one branch over.
          ceilingHit = true;
        }
      }

      const { data: requestId, error: err } = await db.rpc("abo_mcp_propose", {
        p_project: project.id,
        p_request: request,
        p_plans: plans,
        p_summary: design,
        // Stored apart from the rendered text because the card keeps
        // this visible while the details fold away: everything else
        // can be rebuilt from the plans, this cannot.
        p_unmet: unmet,
      });
      if (err) return ok(id, text({ error: err.message }));


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
            // What really happened, not that something happened. With
            // errors in it the row lands as partly_built.
            p_payload: { applied, errors },
          });
          await db.from("build_requests").update({ auto_built: true }).eq("id", requestId);
          // Written here, not by the browser. Nobody tapped anything —
          // that is the whole point of automatic builds — so if this
          // did not record it, the app would change and the merchant's
          // history would stay blank.
          await logClientBuild(db, project.id, request, builtLine(plans, moduleList, errors));
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
        // rather than being reported as done — but the reason it could
        // not be built used to be dropped right here, and the answer
        // was an ordinary "waiting for approval". So a merchant with
        // automatic builds switched on saw it silently stop working,
        // and nothing anywhere said why. Carried out instead.
        autoFailed = errors;
      }

      return ok(
        id,
        text({
          // Said plainly so the model reports it plainly: nothing has
          // been built, and somebody still has to say yes.
          status: "waiting for approval",
          note: "Nothing has changed yet. Read this design back to the merchant word for word. If they approve, call approve_change with the request_id. If they leave it and come back later, check pending_changes rather than trusting this id — they may have dealt with it in Warmluke.",
          request_id: requestId,
          design,
          // When the merchant has asked for automatic builds, say why
          // this one still needs them. Otherwise they are left
          // wondering why the setting did nothing.
          ...(autoFailed.length > 0
            ? {
                not_automatic_because: `it could not be built: ${autoFailed.slice(0, 3).join("; ")}`,
              }
            : ceilingHit
              ? {
                  not_automatic_because: `this app has already been built automatically ${AUTO_BUILDS_PER_DAY} times today, so the rest of today's changes wait for the merchant`,
                }
              : wantsAuto && autoReason
                ? { not_automatic_because: autoReason }
                : {}),
          open: `${origin}/app/${project.id}`,
        })
      );
    }

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
  // Closed when it cannot be asked, not open. `=== false` treated an
  // unreachable database as permission.
  const { data: mcpOn, error: mcpGate } = await db.rpc("abo_feature", { p_name: "mcp" });
  if (mcpGate || mcpOn === false) {
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
      // The error is read, which it was not: `if (turns && !turns.ok)`
      // let a failed allowance call through as though the account had
      // room, and the model then ran on our key for somebody we never
      // managed to charge. The chat route has always thrown here; this
      // one silently agreed.
      const { data: allowance, error: spendErr } = await db.rpc("abo_spend_turn");
      if (spendErr) throw new Error(spendErr.message);
      const turns = allowance as
        | { ok: boolean; used: number; free: number; spend_id?: string }
        | null;
      if (!turns || !turns.ok) {
        return ok(
          id,
          text({
            // An allowance we could not read is not an allowance of
            // zero, and saying "you have used all 0" would be a lie
            // about the merchant rather than about us.
            error: turns
              ? `This account has used all ${turns.free} included design${turns.free === 1 ? "" : "s"} from Warmluke.`
              : "Warmluke could not check how many included designs this account has left, so it has not started a design.",
            // The old wording sent them to a paywall that does not
            // exist. What actually costs money is Warmluke doing the
            // designing; you doing it costs nothing, and that door is
            // open with no limit on it.
            note: "That counter is only for designs Warmluke writes. Write this one yourself instead: call design_format, then submit_design. It is checked by the same validator, goes to the merchant the same way, and does not touch the counter.",
            do_this_instead: "design_format",
            reading_still_works: "orders, stock, products, customers — and pending_changes says what, if anything, is still waiting to be approved",
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
        // The note below says nothing has been requested. Charging a
        // design for it made that sentence false — and a design that
        // needed one round of questions cost two of the ten.
        await db.rpc("abo_refund_turn", { p_spend: turns?.spend_id ?? null });
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

      // An answer is a reply to a question, and nobody asked one here:
      // this path exists to design a change. Refusing beats settling a
      // design that has no plans in it.
      if (turn.reply.type === "answer") {
        return ok(id, text({ error: "That reads as a question, not a change to make." }));
      }

      const design = blueprintAsText(turn.reply, moduleList, turn.store, turn.unmet);
      const plans =
        turn.reply.type === "blueprint" ? turn.reply.blueprint.plans : turn.reply.plans;

      return settleDesign({
        db,
        id,
        origin: new URL(req.url).origin,
        project,
        moduleList,
        plans,
        design,
        unmet: turn.unmet ?? [],
        request,
        store: turn.store,
      });
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
            // Rules that belong to the app rather than to one section.
            // Left out, an assistant asked "does anything run daily?"
            // had to guess, and guessed no.
            rules_on_the_whole_app: describeRules(
              ((await ruleRowsFor(db, project.id, null)) ?? []) as RuleRow[],
              sections
            ),
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
      // read_section says it explains how a section works, and left
      // the rules out of that explanation entirely — so an assistant
      // asked why a status keeps changing by itself could not see the
      // rule changing it.
      const sectionRules = describeRules(
        ((await ruleRowsFor(db, project.id, section.id)) ?? []) as RuleRow[],
        sections
      );
      const setup = {
        section: section.nav_label,
        rows_from: section.source_table ? `Shopify ${section.source_table}` : "this app",
        version: schemaRow?.version ?? null,
        fields: (sj.columns ?? []).map((c) => ({ field: c.field, label: c.label, type: c.type })),
        features: sj.features ?? null,
        rules: sectionRules.length ? sectionRules : "none on this section",
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

    if (name === "pending_changes") {
      // approve_change needs a request_id, and until this existed the
      // only place to get one was the model's memory of its own
      // propose_change call. So it listed things from memory — designs
      // the merchant had since dismissed or built — and called them
      // waiting. They were not.
      const wanted = (args.project_id as string | undefined)?.trim();

      // An id is resolved, never trusted. Filtering on one that is not
      // theirs returns nothing, and "nothing is waiting" said about the
      // wrong app is the same lie this tool exists to stop.
      const { data: mine } = await db.from("projects").select("id, name");
      const projectList = (mine ?? []) as Array<{ id: string; name: string }>;
      if (wanted && !projectList.some((p) => p.id === wanted)) {
        return ok(
          id,
          text({
            error: `No app of theirs has the id ${wanted}.`,
            note: "Do not tell the merchant anything about what is waiting — this answer covers no app at all.",
            projects: projectList.map((p) => ({ id: p.id, name: p.name })),
          })
        );
      }

      const client = clientIdOf(req);
      let q = db
        .from("build_requests")
        .select(
          "id, project_id, request, summary, status, approved_at, created_at, client_id, outcome",
          { count: "exact" }
        )
        // partly_built is not waiting for anybody, but it is the one
        // state nobody may be left unaware of: a section exists with
        // half of what was asked for. Hiding it is how it stays broken.
        .in("status", ["pending", "building", "partly_built"])
        .order("created_at", { ascending: false })
        .limit(SHOW_WAITING);
      if (wanted) q = q.eq("project_id", wanted);
      const { data: waiting, count, error: wErr } = await q;
      if (wErr) return ok(id, text({ error: wErr.message }));

      const rows = waiting ?? [];
      const total = count ?? rows.length;
      return ok(
        id,
        text({
          // rows.length alone read as the whole truth once the queue
          // grew past a page of it.
          total,
          showing: rows.length,
          ...(total > rows.length
            ? { has_more: `${total - rows.length} older ones are not listed here.` }
            : {}),
          note: total
            ? "Only the ones marked awaiting_approval need the merchant's yes. Anything marked partly built already happened and cannot be finished from here — say what is missing. Read a waiting one back and call approve_change with its request_id if they say so."
            : "Nothing is waiting for approval. Do not tell the merchant otherwise — anything from earlier in this conversation has since been built or dismissed.",
          waiting: rows.map((r) => {
            const shaped = shapeRequest(r as RequestRow, client);
            return {
              ...shaped,
              next_action:
                r.status === "partly_built"
                  ? "Some of this was built and some was not. Tell the merchant exactly which, and ask for the missing part again as a new request — approve_change will not finish this one."
                  : shaped.state === "building"
                    ? // ponytail: no lease on a claim yet, so a build
                      // that died mid-way sits here. Say so rather than
                      // invent a timeout; add claimed_at and a recovery
                      // path when one is actually seen stuck.
                      "Somebody is applying this now. If it has been like this for a long time, the merchant can look in Warmluke."
                    : shaped.state === "approved, not built yet"
                      ? shaped.you_can_approve_it
                        ? "Already approved — call approve_change with this request_id to build it."
                        : "Already approved. The assistant that raised it, or the merchant in Warmluke, builds it."
                      : shaped.you_can_approve_it
                        ? "Read the design back. If they say yes, call approve_change with this request_id; if they say no, call reject_change so it stops asking."
                        : "Not yours to approve — tell the merchant it is waiting in Warmluke.",
            };
          }),
        })
      );
    }

    if (name === "build_history") {
      const wanted = (args.project_id as string | undefined)?.trim();
      const { data: mine } = await db.from("projects").select("id, name");
      const projectList = (mine ?? []) as Array<{ id: string; name: string }>;
      // Same rule as pending_changes: an id is resolved, never trusted.
      // An empty answer about the wrong app reads as an answer about
      // the right one.
      if (wanted && !projectList.some((p) => p.id === wanted)) {
        return ok(
          id,
          text({
            error: `No app of theirs has the id ${wanted}.`,
            note: "Do not tell the merchant anything about their history — this answer covers no app at all.",
            projects: projectList.map((p) => ({ id: p.id, name: p.name })),
          })
        );
      }

      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50);
      const before = String(args.before ?? "").trim();
      const client = clientIdOf(req);

      let q = db
        .from("build_requests")
        .select(
          "id, project_id, request, summary, status, approved_at, created_at, built_at, client_id, outcome"
        )
        // Everything that happened, not only what worked. A history
        // that hides the failures is the reason none of this was
        // trustworthy in the first place.
        .in("status", ["built", "partly_built", "dismissed", "opened"])
        .order("created_at", { ascending: false })
        .limit(limit + 1);
      if (wanted) q = q.eq("project_id", wanted);
      if (before) q = q.lt("created_at", before);
      const { data: rows, error: hErr } = await q;
      if (hErr) return ok(id, text({ error: hErr.message }));

      // One extra was asked for, purely to know whether there is more.
      const page = (rows ?? []).slice(0, limit);
      const more = (rows ?? []).length > limit;
      const half = page.filter((r) => r.status === "partly_built").length;

      return ok(
        id,
        text({
          showing: page.length,
          ...(more
            ? {
                more: "There are older ones. Pass next_before to see them.",
                next_before: page[page.length - 1]?.created_at,
              }
            : {}),
          ...(half
            ? {
                needs_attention: `${half} of these only partly worked. Say which part is missing rather than describing them as done.`,
              }
            : {}),
          note: page.length
            ? "Newest first. Anything waiting for approval is not here — that is pending_changes."
            : "Nothing has been built in this app yet. Do not describe earlier work from memory.",
          history: page.map((r) => shapeRequest(r as RequestRow, client)),
        })
      );
    }

    if (name === "reject_change") {
      const requestId = String(args.request_id ?? "").trim();
      if (!requestId) return ok(id, text({ error: "Which request? Pass request_id." }));

      const { data: said, error: rErr } = await db.rpc("abo_reject_request", {
        p_request: requestId,
      });
      if (rErr) return ok(id, text({ error: rErr.message }));
      const answer = said as
        | { rejected: boolean; already?: boolean; status?: string; reason?: string }
        | null;

      if (!answer?.rejected) {
        return ok(
          id,
          text({
            status: "not rejected",
            error: answer?.reason ?? "That request could not be refused.",
            ...(answer?.status ? { it_is: answer.status } : {}),
          })
        );
      }

      // The merchant's words are worth keeping — they are what makes
      // the decision recognisable in build_history a week later. Best
      // effort: the refusal itself is already recorded and must not be
      // undone by a failure to annotate it.
      const reason = String(args.reason ?? "").trim();
      if (reason) {
        await db
          .from("build_requests")
          .update({ summary: reason.slice(0, 2000) })
          .eq("id", requestId);
      }

      return ok(
        id,
        text({
          status: "dismissed",
          ...(answer.already ? { note: "It was already dismissed. Nothing changed." } : {}),
          note: answer.already
            ? "It was already dismissed. Nothing changed."
            : "Recorded. It has left their queue, and their app will stop asking about it.",
        })
      );
    }

    if (name === "design_format") {
      // Written once, for the model that has to obey it. The engine's
      // own prompt is built from this same function, so a client
      // reading it is being told exactly what Warmluke tells itself.
      return ok(
        id,
        text({
          note: "Write the design yourself and send it with submit_design. This does not use one of the merchant's included designs — their subscription is paying for your thinking, not ours.",
          envelope: '{ "plans": [ <plan>, ... ] } — applied in order, up to 6.',
          // The real shape, not a description of it. This is the same
          // constant Luke is given, so what a client reads here and
          // what the validator enforces cannot drift apart.
          plan_format: PLAN_FORMAT,
          allowed_icons: ALLOWED_ICONS,
          worked_example: WORKED_EXAMPLE,
          two_things_that_get_guessed_wrong: [
            'The operator key is "op", never "operator" or "type": { "op": "<=", "args": [ { "field": "available" }, { "const": 5 } ] }.',
            '"view" belongs inside "features", not inside "newSchema".',
          ],
          store_backed_sections:
            "A section with source_table shows Shopify's own rows. Its columns are the store's — send newSchema as null and it is filled in. You cannot add a column of your own to one (an import would overwrite it), so express a flag as a stat or a filter over the columns that are there.",
          removing_a_section:
            "MODULE_DELETE is not accepted here at all. The merchant types the section's name in Warmluke to confirm that one.",
          vocabulary: vocabularyPrompt(),
        })
      );
    }

    if (name === "validate_design" || name === "submit_design") {
      const dryRun = name === "validate_design";
      const given = args.plans;
      if (!Array.isArray(given) || given.length === 0) {
        return ok(
          id,
          text({
            error: "Pass plans: an array of plan objects.",
            note: "Call design_format first if you have not seen the shape. It returns the real JSON, not a description of it.",
          })
        );
      }

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

      // The same validator the engine answers to, with the same
      // arguments it is given here. A design that would be rejected
      // coming out of Warmluke's own model is rejected coming out of
      // anybody else's — that is the whole reason this is safe to
      // offer. No model runs on our side, so no turn is spent.
      const schemas = await schemasFor(db, moduleList);
      const checked = parseReply(
        JSON.stringify({ plans: given }),
        moduleList,
        null,
        null,
        (moduleId) => schemas.get(moduleId) ?? null
      );
      if (!checked.ok || checked.reply.type === "clarify") {
        return ok(
          id,
          text({
            status: "not accepted",
            errors: checked.ok ? ["That is not a design — it is a set of questions."] : checked.errors,
            note: dryRun
              ? "A dry run: nothing has been requested and the merchant has seen nothing. Correct these and check again."
              : "Correct these and call submit_design again. Nothing has been requested or changed, and this cost the merchant nothing.",
            hint: "design_format returns the exact shape, including a worked example.",
          })
        );
      }

      if (checked.reply.type === "answer") {
        return ok(id, text({ error: "That reads as a question, not a change to make." }));
      }
      const plans =
        checked.reply.type === "blueprint" ? checked.reply.blueprint.plans : checked.reply.plans;

      // The dry run stops here. It reads the same state and runs the
      // same validator, and then goes no further: no request row, no
      // approval card, nothing for the merchant to dismiss. Writing a
      // design used to mean finding out whether it held by sending it,
      // which put every failed attempt on somebody's screen.
      if (dryRun) {
        return ok(
          id,
          text({
            status: "holds",
            note: "Nothing was requested and the merchant has seen nothing. Call submit_design with these same plans to put it in front of them.",
            would_build: plans.map((pl) => describePlan(pl, moduleList)),
          })
        );
      }

      const request =
        String(args.request ?? "").trim() ||
        // The card is read by a person who has to recognise what they
        // asked for. Falling back to the design's own words beats an
        // empty line.
        plans.map((pl) => pl.explanation).filter(Boolean).join(" ") ||
        "A change designed by their own assistant";

      return settleDesign({
        db,
        id,
        origin: new URL(req.url).origin,
        project,
        moduleList,
        plans,
        design: blueprintAsText({ type: "plans", plans }, moduleList, null, []),
        unmet: [],
        request,
        store: null,
      });
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
        p_payload: { applied, errors },
      });

      // Approved inside their own Claude, so the browser never saw it
      // and never wrote it down. Read after the build, so a section it
      // just created is named rather than shown as an unknown id.
      const { data: builtMods } = await db
        .from("modules")
        .select("*")
        .eq("project_id", reqRow.project_id);
      await logClientBuild(
        db,
        reqRow.project_id,
        reqRow.request,
        builtLine(reqRow.plans ?? [], (builtMods ?? []) as ModuleRow[], errors)
      );

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
    // An owner with two projects has two stores, and stores[0] is
    // whichever the database returned first — so a question about one
    // shop could be answered from the other, silently and with a
    // straight face. Ambiguity is now a question rather than a guess.
    const store = wanted
      ? stores.find((s) => s.shop_domain.toLowerCase() === wanted)
      : stores.length === 1
        ? stores[0]
        : null;
    if (!store && !wanted && stores.length > 1) {
      return ok(
        id,
        text({
          error: "More than one store is connected. Say which one.",
          available: stores.map((s) => s.shop_domain),
        })
      );
    }
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
