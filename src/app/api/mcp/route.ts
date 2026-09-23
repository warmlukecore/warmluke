import { NextResponse, after } from "next/server";
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
  storeLeaders,
  storeOverview,
  storeTableSchema,
  STORE_TABLES,
} from "@/lib/store-read";
import { RESOURCES, SHOPIFY_RESOURCES } from "@/lib/shopify-resources";
import { blueprintAsText, runTurn, schemasFor, storeFactsFor } from "@/lib/engine";
import { PLAN_FORMAT, WORKED_EXAMPLE, parseReply } from "@/lib/ai";
import { vocabularyPrompt } from "@/lib/capabilities";
import {
  describePlan,
  describeRules,
  seededCopies,
  stepsToFinish,
  stepsToFinishAction,
  type RuleRow,
} from "@/lib/describe";
import {
  ACTIONS,
  MOST_TARGETS,
  STORE_ACTIONS,
  actionSpec,
  whatCanChange,
  whatNeverChanges,
  type ActionTarget,
} from "@/lib/store-actions";
import { applyPlans, logClientBuild, putBack } from "@/lib/apply";
import { undoableFrom } from "@/lib/undo";
import { noteJudgement } from "@/lib/judge";
import { routeQuestion } from "@/lib/route";
import { fetchSlice } from "@/lib/slice";
import { ALLOWED_ICONS } from "@/lib/types";
import type { AssistantPlan, ModuleRow, NextStep, ProjectRow, UiSchema } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/mcp — the merchant's own assistant, reading their store.
 *
 * Streamable HTTP in its simplest honest form: every request gets one
 * JSON response, no SSE and no session. Both are optional in the spec,
 * and a server that keeps no state cannot lose any — nothing here
 * streams, so pretending to would be ceremony.
 *
 * The store's data is read here and never written through these
 * tools. Two things can be changed, each along one path. The app:
 * propose_change designs it — the assistant never writes plans — and
 * approve_change builds it once the merchant has heard that design and
 * said yes. The shop: propose_store_action asks for one of the changes
 * in lib/store-actions, and only the merchant can agree to it, in
 * Warmluke. The database enforces both; a token carrying client_id
 * cannot write anything else at all.
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

/**
 * Appended to every tool that answers with data.
 *
 * A merchant asked their Claude for a report with charts. The numbers
 * came back right and the charts came back empty: the artifact reached
 * for a charting library from a CDN, and the sandbox it renders in
 * does not load one. Nothing here can draw the chart — but the tool's
 * own description is the one place the model reads before it starts,
 * so it is the one place to say so.
 */
const RENDER_NOTE =
  " If you show this in an artifact, draw charts as inline SVG — scripts from a CDN do not load there, and a chart that needs one comes out blank. If the merchant wants this to stay, build it as a section in Warmluke instead: propose_change or submit_design.";

/**
 * Everything that can be asked for, off the registry.
 *
 * Built here rather than written into the tool's description, so an
 * action added tomorrow is offered tomorrow. It carries what each
 * one needs and whether it can be taken back, because an assistant
 * that knows a change is permanent asks differently.
 */
const ACTION_CATALOGUE = ACTIONS.map((a) => {
  const spec = STORE_ACTIONS[a];
  return {
    action: a,
    does: spec.label,
    store_must_allow: spec.scopes,
    ...(spec.undo
      ? { can_be_taken_back: true }
      : { cannot_be_taken_back: spec.undoNote ?? "This one cannot be undone." }),
  };
});

/**
 * What the assistant sent, as targets this can work with.
 *
 * A model asked for a tag on "1234" and on "gid://shopify/Order/1"
 * in the same breath; both are the obvious thing to send and only
 * one of them means anything to Shopify. Strings are lifted into
 * objects, anything without a usable id is named back.
 */
function readTargets(given: unknown): { targets: ActionTarget[]; wrong: string[] } {
  const list = Array.isArray(given) ? given : [];
  const targets: ActionTarget[] = [];
  const wrong: string[] = [];
  for (const item of list) {
    const t =
      typeof item === "string"
        ? { id: item }
        : item && typeof item === "object"
          ? ({ ...(item as Record<string, unknown>) } as ActionTarget)
          : null;
    const id = t && typeof t.id === "string" ? t.id.trim() : "";
    if (!id) {
      wrong.push(`${JSON.stringify(item).slice(0, 60)} has no id`);
    } else if (!/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(id)) {
      wrong.push(`"${id}" is not a Shopify id — they look like gid://shopify/Order/1234`);
    } else {
      targets.push({ ...t, id });
    }
  }
  return { targets, wrong };
}

const TOOLS = [
  {
    name: "ask_store",
    description:
      "Start here for a question about the shop: who buys most, what sold this month, is #1004 paid, stock of something, how many orders this week. Reads the question, picks the right list and time span, and returns those rows with a line saying what they are. When it cannot tell, it says so and names the tool to use instead." +
      RENDER_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The merchant's question, in their own words — English or Hinglish.",
        },
        shop_domain: {
          type: "string",
          description: "Which store, when the account has more than one. Optional.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "store_overview",
    description:
      "What is in the merchant's connected Shopify store: the shop domain, its timezone and currency, when it last synced, and how many rows it holds of each list Shopify fills." + RENDER_NOTE,
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
      "Find orders in the connected store. A day is read in the store's own timezone, not the caller's — asking for yesterday in New York and getting UTC's yesterday would be a wrong answer." + RENDER_NOTE,
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
      "One order in full, with the items in it. Use this when the merchant asks about a particular order; search_orders lists many and deliberately leaves the contents out." + RENDER_NOTE,
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
    // Named from the one declaration of the lists rather than by hand.
    // This sentence is how the client learns a list exists at all, and
    // it had gone on naming five while the enum below offered nine —
    // so shipments and refunds were searchable and never searched.
    description:
      `Look through any of the store's lists: ${Object.values(STORE_TABLES)
        .map((spec) => spec.section.label)
        .join(", ")}. Read-only, and it only sees what has been synced from Shopify.` + RENDER_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          // The lists are declared once, in store-read; this is that list.
          enum: Object.keys(STORE_TABLES),
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
      "Products running out: every variant at or below a number, lowest first, with the location it is short at. Ask with threshold 0 for what is already out of stock." + RENDER_NOTE,
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
      "How a section in the merchant's Warmluke app is put together — its fields, its filters, its stats, where its rows come from — and its rows when it holds its own. Call it with no arguments to list the sections. Use this before guessing why something on screen behaves the way it does." + RENDER_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The section's name, as listed." },
        history: {
          type: "boolean",
          description:
            "Return how this section has changed instead of its rows: every version, newest first, with when it was made, who by, and the fields it held. Use it to answer \"what did this look like before?\" and to propose putting it back.",
        },
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
            "An ISO instant. Returns only requests raised before it. Take the `next_before` value from the last answer and send it here, as `before` — `next_before` is accepted too, because the two names are easy to mix up.",
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
    name: "undo_build",
    description:
      "Put back a build this assistant made. Reverses what that build recorded — a section's fields and settings, a renamed section, a rule, rows it seeded — and says what it could not put back. A section this build CREATED is never removed by an undo: that takes every row with it, and the merchant removes it in Warmluke by typing its name. Use build_history to find the request_id. Read back what came off, in their words.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description: "The id of the build to reverse, from build_history or approve_change.",
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
    name: "propose_store_action",
    description:
      "Ask for something to be changed IN the merchant's Shopify shop itself — a tag on some orders, a note, a stock count. Warmluke writes the sentence they will read, from the change, not from you. Nothing happens until they agree to it in Warmluke, and you cannot agree for them: a change to a live shop is theirs alone, whatever the app's auto-build setting says. Call it once per kind of change; the answer says what they have to do next. What can be asked for: " +
      ACTION_CATALOGUE.map((c) => `${c.action} (${c.does})`).join(", ") + ".",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: `One of: ${ACTIONS.join(", ")}.`,
        },
        targets: {
          type: "array",
          items: { type: "object" },
          description:
            'What it changes. Each carries Shopify\'s own id — { "id": "gid://shopify/Order/1234" } — plus whatever that change needs for that one line, such as a quantity.',
        },
        params: {
          type: "object",
          description: 'What to set, the same for every target: { "tags": ["rush"] } or { "note": "…" }.',
        },
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
        project_id: { type: "string", description: "Which app, when they have more than one. Optional." },
      },
      required: ["action", "targets"],
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
 * Where the merchant goes, and what is in front of them when they
 * land.
 *
 * Every answer here used to hand back the app's front door and leave
 * them to find the thing: ten links, all of them /app/<id>, opening
 * on a closed bell. With the request named, the panel opens on it —
 * on a phone too, where the panel is a drawer that starts shut and
 * nothing at all was visible.
 */
const openAt = (origin: string, projectId: string, requestId?: string | null) =>
  `${origin}/app/${projectId}${requestId ? `?waiting=${requestId}` : ""}`;

/**
 * There is no ceiling on automatic builds any more.
 *
 * There used to be five a day, against a client stuck in a loop. But
 * every design already spends one of the merchant's included turns
 * before it is built, so a loop stops itself at the quota — the
 * ceiling only ever stopped the merchant who meant it, and stopped
 * them in the middle of a day's work with no way to raise it.
 *
 * The one account with no quota to stop it is one an admin has
 * deliberately set to unlimited.
 */

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
  /** Only read where the query asks for them; what the merchant does next comes off these. */
  plans?: AssistantPlan[] | null;
};

const shapeRequest = (
  r: RequestRow,
  client: string | null,
  /**
   * Sections that still exist, when the caller has looked them up.
   *
   * "Built" is a fact about the past. Whether the thing is still there
   * is a different fact, and the answer used to imply the first meant
   * the second: a merchant asked for a scan bar, was told it had been
   * built weeks ago and was ready to use, and opened an app where the
   * section had since been deleted. Undefined means nobody checked,
   * and then nothing is claimed either way.
   */
  liveModules?: Set<string>
) => {
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
          ...(() => {
            if (!liveModules) return {};
            // Only a request that actually finished can claim this.
            // The sentence below asserts "it was built", and a row
            // that never got that far must not say so whatever else
            // is in its outcome.
            if (!r.built_at) return {};
            const touched = (r.outcome.applied ?? [])
              .map((a) => (a as { moduleId?: string }).moduleId)
              .filter((m): m is string => typeof m === "string");
            const gone = [...new Set(touched.filter((m) => !liveModules.has(m)))];
            return gone.length
              ? {
                  no_longer_there: `The ${gone.length === 1 ? "section" : "sections"} this built ${
                    gone.length === 1 ? "has" : "have"
                  } since been deleted. It was built, and it is not there now — do not tell the merchant to go and look at it.`,
                }
              : {};
          })(),
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
 * about approval, and the only way to be sure of that is for there to
 * be one copy of it. check-auto-scope leans on exactly that: it drives
 * the free door, because the decision is the same one.
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
  /**
   * What the design offered to do after this one, in the merchant's
   * words. Luke has produced these since follow-ups were added and
   * this door threw them away, so a build through their own
   * assistant ended in silence while the same build in the app ended
   * with two things worth doing next.
   */
  next?: NextStep[];
  store: Parameters<typeof blueprintAsText>[2];
  /** Told once the request row is written, so the caller can stop treating the turn as refundable. */
  charged?: () => void;
}) {
  const { db, id, origin, project, moduleList, plans, design, unmet, next, request, store, charged } = opts;
  // Offered, never done from here: each is a sentence the merchant
  // might say, not a button this can press. Not named `after`, which
  // is next/server's — shadowing it turns the judge below into a
  // type error, and would have turned it into silence.
  const followUps = (next ?? []).filter((n) => n?.label && n?.prompt).slice(0, 2);
  const whatNext = followUps.length
    ? {
        next_steps: followUps.map((n) => ({ say: n.label, as: n.prompt })),
        next_steps_note:
          "Offer these in their own words and wait. Each is another change, so it needs proposing and approving like this one did.",
      }
    : {};

      // ── Does this one get to skip the merchant? ──────────────
      //
      // The switch says they are willing; this decides whether THIS
      // design qualifies. The setting says everything, so the only
      // thing left to decide is whether there is anything to build.
      // The switch means everything now, so the only design that
      // cannot be built on its own is one with nothing in it.
      const autoReason = plans.length === 0 ? "there is nothing to build" : null;
      const wantsAuto = project.auto_build === true;

      // A design that removes a section is now proposed like any
       // other, and built like no other.
       //
       // It used to be refused here outright, so "delete the Variants
       // section" was a dead end: no request, no card, nothing for the
       // merchant to act on but a sentence telling them to go and find
       // it themselves. The refusal was aimed at the right thing —
       // removal takes every row and does not come back, and the one
       // confirmation that guards it is typing the section's name,
       // which a chat window cannot ask for. But refusing the REQUEST
       // was never what protected them; refusing the BUILD is.
       //
       // So it waits in Warmluke, where that name is typed. Never
       // automatically, whatever the project's setting says, and
       // approve_change still refuses it.
      const gone = removals(plans);

      const automatic = wantsAuto && autoReason === null && gone.length === 0;
      // Why an automatic build did not happen, when it was meant to.
      let autoFailed: string[] = [];

      const { data: requestId, error: err } = await db.rpc("abo_mcp_propose", {
        p_project: project.id,
        p_request: request,
        p_plans: plans,
        p_summary: design,
        // Stored apart from the rendered text because the card keeps
        // this visible while the details fold away: everything else
        // can be rebuilt from the plans, this cannot.
        p_unmet: unmet,
        // And the follow-ups, for the same reason. With auto-build
        // off the build happens in approve_change hours later, and
        // nothing there could have known what this design offered.
        p_next: followUps.length ? followUps : null,
      });
      if (err) return ok(id, text({ error: err.message }));
      charged?.();

      // A second opinion on the design — Luke's or the assistant's own
      // — taken after this answer has gone out, and written down where
      // nothing reads it yet.
      after(() =>
        noteJudgement(db, {
          projectId: project.id,
          source: "mcp",
          ref: requestId as string,
          request,
          plans,
          modules: moduleList,
          store,
          unmet,
        })
      );


      if (automatic) {
        // auto-build IS the approval — given in Warmluke, on this
        // project, before any of this was asked for. The stamp records
        // that, so the row says who agreed and when.
        //
        // And the answer is read. It was not: abo_approve_request can
        // refuse — it is the only place that decides whether a client
        // may stamp anything — and this went straight on to apply
        // plans that abo_build then rejected one by one for want of an
        // approved_at. The failure arrived as a list of write errors
        // about permissions, never as the reason it was actually
        // refused.
        const { data: nod } = await db.rpc("abo_approve_request", { p_request: requestId });
        const approval = nod as { approved: boolean; reason?: string } | null;
        if (!approval?.approved) {
          return ok(
            id,
            text({
              status: "waiting for approval",
              request_id: requestId,
              design,
              not_automatic_because:
                approval?.reason ?? "the merchant has to approve this one in Warmluke",
              note: "Nothing has changed yet. Read this design back to the merchant, then read them what_the_merchant_does — it is what actually finishes this.",
              what_the_merchant_does: stepsToFinish(
                { status: "pending", plans },
                openAt(origin, project.id, requestId as string)
              ),
              open: openAt(origin, project.id, requestId as string),
            })
          );
        }
        const { applied, errors } = await applyPlans(db, project.id, plans, requestId as string);
        if (applied.length > 0) {
          await db.rpc("abo_build", {
            p_project: project.id,
            p_request: requestId,
            p_op: "request_built",
            // What really happened, not that something happened. With
            // errors in it the row lands as partly_built. And that
            // nobody tapped anything — inside the same write, because
            // this used to be a second one straight at the table, and
            // a connected client is not allowed to write at the table.
            // For every build a real assistant made, it silently did
            // not land, and the row read as approved by the merchant.
            p_payload: { applied, errors, auto_built: true },
          });
          // Written here, not by the browser. Nobody tapped anything —
          // that is the whole point of automatic builds — so if this
          // did not record it, the app would change and the merchant's
          // history would stay blank.
          await logClientBuild(db, project.id, request, builtLine(plans, moduleList, errors), applied);
          return ok(
            id,
            text({
              status: errors.length ? "partly built" : "built",
              note: "This app builds without waiting for approval. Tell the merchant what was built — it is already live and shows in their panel. They can carry on here, or open Warmluke and ask Luke inside it; both reach the same app.",
              ...whatNext,
              // Named even though nobody has to approve it. An
              // automatic build was the one answer that came back
              // without an id, so an assistant that built something
              // had no way to refer to it afterwards — not in
              // build_history, not to the merchant. It is the same id
              // every other answer here carries.
              request_id: requestId,
              built: applied,
              ...(errors.length ? { not_built: errors.slice(0, 3) } : {}),
              design,
              // Built already, so there is nothing to finish — but a
              // half-built one has a card worth opening, and this
              // says so or stays quiet, from the row itself.
              ...(errors.length
                ? {
                    what_the_merchant_does: stepsToFinish(
                      { status: "partly_built", plans },
                      openAt(origin, project.id, requestId as string)
                    ),
                  }
                : {}),
              open: openAt(origin, project.id, requestId as string),
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
        // Recorded on the request, not only returned to the assistant.
        // The merchant looks at a card in Warmluke, not at the tool's
        // answer — and a card that asks with the setting on has to be
        // able to say why, or it reads as the setting not working.
        // Through abo_build, not at the table: a client cannot write
        // there, and this reason was never landing for the one kind
        // of caller that produces it.
        await db.rpc("abo_build", {
          p_project: project.id,
          p_request: requestId,
          p_op: "request_outcome",
          p_payload: { applied: [], errors },
        });
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
          ...whatNext,
          ...(gone.length
            ? {
                cannot_be_approved_from_here: `This removes ${gone.join(", ")}, and removal takes every row in it. It is waiting in Warmluke, where the merchant types the section's name to confirm. Do not call approve_change for it — say plainly that this one they have to confirm themselves.`,
              }
            : {}),
          // When the merchant has asked for automatic builds, say why
          // this one still needs them. Otherwise they are left
          // wondering why the setting did nothing.
          ...(autoFailed.length > 0
            ? {
                not_automatic_because: `it could not be built: ${autoFailed.slice(0, 3).join("; ")}`,
              }
            : wantsAuto && autoReason
              ? { not_automatic_because: autoReason }
              : {}),
          what_the_merchant_does: stepsToFinish(
            { status: "pending", plans },
            openAt(origin, project.id, requestId as string)
          ),
          open: openAt(origin, project.id, requestId as string),
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
        // The first thing every connected assistant reads about this
        // server. It said "store data is read-only" after the shop
        // could be changed, which is the one sentence that guarantees
        // an assistant never offers to. What can change comes off the
        // registry, so it stays true as actions are added.
        `One merchant's Warmluke app and connected Shopify store. A day always means a day in the store's own timezone. Changes to their app go through propose_change, which returns a design, and approve_change, which builds it only after they have heard the design and agreed. Changes to their shop go through propose_store_action: it can ${whatCanChange()}, and only the merchant can agree to one, in Warmluke — you cannot, whatever their settings say. It has no way to ${whatNeverChanges()} anything.`,
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
            open: openAt(new URL(req.url).origin, project.id),
          })
        );
      }

      // The turn that may still be given back. Cleared only once the
      // design has been written down for the merchant; every other way
      // out — questions, a validator that gave up, a question mistaken
      // for a request, a throw anywhere after the charge — hands it
      // back in `finally`. The chat route settles the same way.
      let refundable: string | null = turns.spend_id ?? null;
      try {
        const turn = await runTurn({
          client: db,
          project,
          modules: moduleList,
          message: request,
          // This tool cannot build. The design it hands back is the
          // showing, so plain plans are a perfectly good answer — in
          // the chat they would mean building before anyone had seen a
          // plan.
          plansAllowed: true,
          signal: req.signal,
        });
        if (!turn.ok) {
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
        // merchant is already in this conversation, so they answer
        // here and the request comes back complete — no trip to the
        // app to fill in what could have been asked out loud. The
        // note says nothing has been requested; charging a design for
        // it would make that sentence false.
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

        // An answer is a reply to a question, and nobody asked one
        // here: this path exists to design a change. Refusing beats
        // settling a design that has no plans in it.
        if (turn.reply.type === "answer") {
          return ok(id, text({ error: "That reads as a question, not a change to make." }));
        }

        const design = blueprintAsText(turn.reply, moduleList, turn.store, turn.unmet);
        const plans =
          turn.reply.type === "blueprint" ? turn.reply.blueprint.plans : turn.reply.plans;

        return await settleDesign({
          db,
          id,
          origin: new URL(req.url).origin,
          project,
          moduleList,
          plans,
          design,
          unmet: turn.unmet ?? [],
          next: turn.reply.type === "blueprint" ? turn.reply.blueprint.next : turn.reply.next,
          request,
          store: turn.store,
          // Charged the moment the request row exists — that is what
          // the merchant gets for the turn. A row that would not
          // insert is our failure, and the turn comes back.
          charged: () => {
            refundable = null;
          },
        });
      } finally {
        if (refundable) await db.rpc("abo_refund_turn", { p_spend: refundable });
      }
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

      // How it got to be this way, when that is what was asked.
      //
      // Versions are appended and never rewritten, so this is the
      // real history — including a version put back, which appears as
      // a new one holding what the old one held. Without it an
      // assistant asked "put Orders back to how it was on Friday" had
      // nothing to read and could only guess at what Friday held.
      if (args.history === true) {
        const { data: versions } = await db
          .from("ui_schemas")
          .select("version, created_by, change_description, created_at, schema_json")
          .eq("module_id", section.id)
          .order("version", { ascending: false })
          .limit(30);
        return ok(
          id,
          text({
            section: section.nav_label,
            versions: (versions ?? []).map((v) => ({
              version: v.version,
              on: v.created_at,
              by: v.created_by === "ai" ? "Warmluke" : "the merchant",
              what_changed: v.change_description ?? null,
              fields: ((v.schema_json as UiSchema | null)?.columns ?? []).map((c) => c.field),
            })),
            note: "Putting one back is an ordinary change: propose_change describing the version to restore. Nothing is overwritten — restoring version 3 writes a new version holding what 3 held.",
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
          // plans, because what the merchant has to do to finish one
          // is read off them: a design that removes a section takes
          // two more taps and a name typed out.
          "id, project_id, request, summary, status, approved_at, created_at, client_id, outcome, plans",
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

      // Changes to the shop wait in their own table and must not be
      // silently missing from the one tool whose job is "what needs
      // them". Kept as a separate list rather than mixed in: a design
      // waiting to be built inside Warmluke and a change waiting to
      // go out to a live shop are not the same yes, and an assistant
      // reading one list would report them as if they were.
      let actionQuery = db
        .from("store_actions")
        .select("id, project_id, store_id, action, summary, status, created_at")
        .in("status", ["pending", "approved", "running"])
        .order("created_at", { ascending: false })
        .limit(SHOW_WAITING);
      if (wanted) actionQuery = actionQuery.eq("project_id", wanted);
      const { data: actionRows } = await actionQuery;
      const shopChanges = (actionRows ?? []).map((a) => {
        const spec = actionSpec(a.action);
        const where = openAt(new URL(req.url).origin, a.project_id, a.id);
        return {
          action_id: a.id,
          changes: a.summary,
          state: a.status === "pending" ? "waiting for the merchant" : a.status,
          // Said every time, because it is the thing an assistant is
          // most likely to get wrong about these.
          you_can_approve_it: false,
          what_the_merchant_does: stepsToFinishAction(a, where, spec),
          open: where,
        };
      });
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
          ...(shopChanges.length
            ? {
                waiting_store_changes: shopChanges,
                store_changes_note:
                  "These change the merchant's Shopify shop, not their Warmluke app. None of them is yours to approve — read what_the_merchant_does and leave it with them.",
              }
            : {}),
          note: total
            ? "Only the ones marked awaiting_approval need the merchant's yes. Anything marked partly built already happened and cannot be finished from here — say what is missing. Read a waiting one back and call approve_change with its request_id if they say so."
            : "Nothing is waiting for approval. Do not tell the merchant otherwise — anything from earlier in this conversation has since been built or dismissed.",
          waiting: rows.map((r) => {
            const shaped = shapeRequest(r as RequestRow, client);
            const where = openAt(new URL(req.url).origin, r.project_id, r.id);
            return {
              ...shaped,
              // The one tool whose whole job is "what is waiting"
              // said nothing about where to go or what to press. Both
              // come from the row, so neither can drift from it.
              open: where,
              what_the_merchant_does: stepsToFinish({ ...(r as RequestRow), plans: (r as RequestRow).plans ?? [] }, where),
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
      // Both spellings. The answer hands back a key called
      // `next_before` and the description said to pass it, so a client
      // reading either one sends `next_before` — which this read as
      // absent. No error, no cursor, the same page again: paging simply
      // never advanced, and nothing anywhere said so.
      const before = String(args.before ?? args.next_before ?? "").trim();
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

      // Which of the sections these builds made are still standing.
      // Without this the history says "built" about something that has
      // since been deleted, and the assistant reads that as "it is
      // there" — which is exactly what happened.
      const touched = [
        ...new Set(
          page.flatMap((r) =>
            ((r.outcome?.applied ?? []) as Array<{ moduleId?: string }>)
              .map((a) => a.moduleId)
              .filter((m): m is string => typeof m === "string")
          )
        ),
      ];
      const { data: alive } = touched.length
        ? await db.from("modules").select("id").in("id", touched)
        : { data: [] as Array<{ id: string }> };
      const liveModules = new Set((alive ?? []).map((m) => m.id));
      const more = (rows ?? []).length > limit;
      const half = page.filter((r) => r.status === "partly_built").length;

      return ok(
        id,
        text({
          showing: page.length,
          ...(more
            ? {
                more: "There are older ones. Send the next_before value below as `before` to see them.",
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
          history: page.map((r) => shapeRequest(r as RequestRow, client, liveModules)),
        })
      );
    }

    if (name === "reject_change") {
      const requestId = String(args.request_id ?? "").trim();
      if (!requestId) return ok(id, text({ error: "Which request? Pass request_id." }));

      // The reason goes in with the no. It used to be written at the
      // table afterwards, which a client's token cannot do — so every
      // refusal a real assistant relayed lost the merchant's words.
      const reason = String(args.reason ?? "").trim();
      const { data: said, error: rErr } = await db.rpc("abo_reject_request", {
        p_request: requestId,
        p_reason: reason || null,
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
          // Named, because "the columns are the store's" told a client
          // nothing it could type. It guessed Shopify's API names —
          // total_price, created_at, fulfillment_status — and was
          // refused seven times over for a section it had not built
          // yet. These are the names, per table, and they do not
          // change.
          // What each list is, in the same words Luke reads — so a
          // client asked for "a SKU list for my orders" finds the list
          // that already is one, instead of building a hand-typed copy.
          store_lists: Object.fromEntries(
            Object.entries(STORE_TABLES).map(([table, spec]) => [table, spec.what])
          ),
          store_columns: Object.fromEntries(
            Object.entries(STORE_TABLES).map(([table, spec]) => [
              table,
              spec.columns.map((c) => c.field),
            ])
          ),
          // What a stat over each table should be — the same words Luke
          // reads, from the same place, so the two doors cannot disagree
          // about what "revenue" means.
          store_advice: Object.fromEntries(
            Object.entries(STORE_TABLES)
              .filter(([, spec]) => spec.advice)
              .map(([table, spec]) => [table, spec.advice])
          ),
          removing_a_section:
            "MODULE_DELETE may be proposed and can never be built from here. It removes every row in the section and does not come back, so the merchant confirms it in Warmluke by typing the section's name. Propose it if that is plainly what they asked for, tell them it is waiting there for them to confirm, and do not call approve_change for it. A request is approved whole or not at all: put a removal in the same design as other changes and none of them can be built from here, so when they ask for a removal AND something else, propose them as two — the other one can then be approved in the conversation while the removal waits for them in Warmluke.",
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

      // Made-up rows beside the store's own are refused here as they
      // are in Luke's own loop: a client once seeded four invented
      // order lines into a copy of the order items, and they sat next
      // to the real orders looking like data.
      const copies = seededCopies(plans, await storeFactsFor(db, project.id));
      if (copies.length) {
        return ok(
          id,
          text({
            status: "not accepted",
            errors: copies,
            note: "Nothing has been requested or changed. Build over the store's list (see store_lists in design_format), or leave the section empty for the merchant to fill.",
          })
        );
      }

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

    if (name === "undo_build") {
      const requestId = String(args.request_id ?? "").trim();
      if (!requestId) return ok(id, text({ error: "Which build? Pass request_id." }));

      // Theirs to see by row-level security, and this assistant's to
      // reverse by the client the token names — the same rule
      // abo_reject_request applies: an app token may act on any of
      // their requests, a connected client only on the ones it
      // raised. Another assistant's build is not its business.
      const me = clientIdOf(req);
      const { data: rows } = await db
        .from("build_requests")
        .select("id, project_id, request, status, outcome, client_id, built_at")
        .eq("id", requestId)
        .limit(1);
      const target = rows?.[0] as
        | {
            id: string;
            project_id: string;
            request: string;
            status: string;
            outcome: { applied?: unknown[] } | null;
            client_id: string | null;
            built_at: string | null;
          }
        | undefined;
      if (!target) return ok(id, text({ error: "No such build on this account." }));
      if (me !== null && target.client_id !== me) {
        return ok(
          id,
          text({
            error: "That build was not made through this assistant, so it cannot be put back from here.",
            note: "The merchant can put it back themselves: its receipt in Warmluke has a \"Put it back\" link.",
            open: openAt(new URL(req.url).origin, target.project_id),
          })
        );
      }
      if (!["built", "partly_built"].includes(target.status)) {
        return ok(
          id,
          text({
            error: `That request is "${target.status}", so there is nothing built to put back.`,
          })
        );
      }

      const steps = undoableFrom(target.outcome?.applied ?? []);
      if (steps.length === 0) {
        return ok(
          id,
          text({
            status: "nothing to put back",
            // The commonest case by far, and the honest reason for it.
            note: "This build made something new rather than changing something that already existed — most likely a section. Putting that back means deleting it and every row in it, which Warmluke asks the merchant to confirm by typing the section's name. Offer that instead of an undo, and do not call approve_change for it.",
            open: openAt(new URL(req.url).origin, target.project_id),
          })
        );
      }
      const what = steps.map((u) => u.what);

      // An undo writes, and a client writes only against a request
      // somebody approved. So it raises one, exactly as a build does,
      // and the same switch decides whether it needs a person.
      const { data: undoId, error: raised } = await db.rpc("abo_mcp_propose", {
        p_project: target.project_id,
        p_request: `Put back: ${target.request}`,
        p_plans: [],
        p_summary: `Puts back ${what.join(", ")}.`,
        p_unmet: [],
      });
      if (raised) return ok(id, text({ error: raised.message }));

      const { data: nod } = await db.rpc("abo_approve_request", { p_request: undoId });
      if (!(nod as { approved?: boolean } | null)?.approved) {
        return ok(
          id,
          text({
            status: "waiting for the merchant",
            would_put_back: what,
            note: "This app asks before it changes anything, and an undo is a change. Tell them the fastest way is the build's own receipt in Warmluke, which has a \"Put it back\" link on it.",
            open: openAt(new URL(req.url).origin, target.project_id),
          })
        );
      }

      // Under the request just approved, because that is the only
      // door a client has. The steps themselves are the ones the
      // build wrote down at the time, not worked out now.
      const { done, couldNot } = await putBack(db, target.project_id, steps, undoId as string);

      await db.rpc("abo_build", {
        p_project: target.project_id,
        p_request: undoId,
        p_op: "request_built",
        p_payload: { applied: [], errors: couldNot, auto_built: true },
      });
      const line = done.length
        ? `↩️ Put back — ${done.join(", ")}.${couldNot.length ? ` The rest could not be: ${couldNot.join("; ")}.` : ""}`
        : `Nothing could be put back: ${couldNot.join("; ")}.`;
      // In their thread, like every other change made from outside
      // the browser, so the app shows it as it happens.
      await logClientBuild(db, target.project_id, `Put back: ${target.request}`, line);

      return ok(
        id,
        text({
          status: done.length ? "put back" : "nothing could be put back",
          put_back: done,
          ...(couldNot.length ? { could_not: couldNot } : {}),
          note: done.length
            ? "Read back exactly what came off. Anything under could_not is still there and has to be dealt with in Warmluke."
            : "Nothing changed. Say why, in their words.",
          open: openAt(new URL(req.url).origin, target.project_id),
        })
      );
    }

    if (name === "approve_change") {
      const requestId = String(args.request_id ?? "").trim();
      if (!requestId) return ok(id, text({ error: "Which request? Pass request_id." }));

      // RLS already limits this to the merchant's own requests.
      const { data: rows } = await db
        .from("build_requests")
        .select("id, project_id, request, plans, summary, status, next")
        .eq("id", requestId)
        .limit(1);
      const reqRow = rows?.[0] as
        | {
            id: string;
            project_id: string;
            request: string;
            plans: AssistantPlan[] | null;
            summary: string | null;
            status: string;
            next: NextStep[] | null;
          }
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
        // The whole request, not the removal alone. One request is one
        // card and one yes, so a design that removes a section and
        // also adds a filter is refused entire — and an assistant that
        // reads only the first line offers to build "the other half",
        // which there is no way to do. Said here, in the refusal, in
        // the numbers of this actual request.
        const alsoWaiting = reqRow.plans.length - goneNow.length;
        return ok(
          id,
          text({
            error: "This design removes a section, which cannot be built from here.",
            note: `It is waiting in Warmluke as a card. The merchant opens it there and types the section's name (${goneNow.join(", ")}) to confirm — that typing is the whole safeguard, which is why it cannot happen through a chat approval. Nothing has changed.`,
            ...(alsoWaiting > 0
              ? {
                  the_rest_of_this_design: `The other ${alsoWaiting} change${alsoWaiting === 1 ? "" : "s"} in this request wait${alsoWaiting === 1 ? "s" : ""} with it: one request is one card and one yes, so no part of it can be approved from here. If they want those now, propose them again on their own, without the removal.`,
                }
              : {}),
            // The refusal is the one answer that most needs them: it
            // is where an assistant has just been told it cannot do
            // this, and the merchant is the only one who can.
            what_the_merchant_does: stepsToFinish(
              reqRow,
              openAt(new URL(req.url).origin, reqRow.project_id, reqRow.id)
            ),
            open: openAt(new URL(req.url).origin, reqRow.project_id, reqRow.id),
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
            what_the_merchant_does: stepsToFinish(reqRow, openAt(new URL(req.url).origin, reqRow.project_id, reqRow.id)),
            open: openAt(new URL(req.url).origin, reqRow.project_id, reqRow.id),
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
        builtLine(reqRow.plans ?? [], (builtMods ?? []) as ModuleRow[], errors),
        applied
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
            : "It is live in their app now. They can keep going here, or open Warmluke and ask Luke inside it — both reach the same app, and anything built either way shows in the panel as it happens.",
          // What this design said was worth doing next, written down
          // when it was proposed. Only on a build that worked: after
          // a partial one the next thing to do is the missing half.
          ...(!errors.length && reqRow.next?.length
            ? {
                next_steps: reqRow.next
                  .filter((n) => n?.label && n?.prompt)
                  .slice(0, 2)
                  .map((n) => ({ say: n.label, as: n.prompt })),
                next_steps_note:
                  "Offer these in their own words and wait. Each is another change, so it needs proposing and approving like this one did.",
              }
            : {}),
          // Half of it landed, so there is a card worth opening and
          // a missing part to ask for again. A clean build returns
          // nothing here, from the same function.
          ...(errors.length
            ? {
                what_the_merchant_does: stepsToFinish(
                  { status: "partly_built", plans: reqRow.plans },
                  openAt(origin, reqRow.project_id, reqRow.id)
                ),
              }
            : {}),
          open: openAt(origin, reqRow.project_id, reqRow.id),
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

    if (name === "propose_store_action") {
      // Refused here as well as in SQL. The database is what makes it
      // true; this is what makes it a sentence the assistant can read
      // out instead of an error code.
      const { data: allowed } = await db.rpc("abo_feature", { p_name: "store_actions" });
      if (allowed !== true) {
        return ok(
          id,
          text({
            error: "Changing the shop from Warmluke is not turned on for this account.",
            note: "Reading everything still works, and designs can still be proposed and built. Ask Warmluke to turn this on for them.",
          })
        );
      }

      const wantedAction = String(args.action ?? "").trim();
      const spec = actionSpec(wantedAction);
      if (!spec) {
        return ok(
          id,
          text({
            error: wantedAction
              ? `There is no change called "${wantedAction}".`
              : "Say which change to ask for.",
            what_can_be_asked_for: ACTION_CATALOGUE,
          })
        );
      }
      // A second connector's actions will be in the same registry and
      // must not be attempted down this road.
      if (spec.connector !== "shopify") {
        return ok(id, text({ error: `Nothing here can reach ${spec.connector} yet.` }));
      }

      const { targets, wrong } = readTargets(args.targets);
      if (wrong.length) {
        return ok(
          id,
          text({
            error: "Some of what you named cannot be acted on.",
            these: wrong.slice(0, 5),
            note: "Shopify's own ids, as they come back from the reading tools.",
          })
        );
      }
      if (targets.length > MOST_TARGETS) {
        return ok(
          id,
          text({
            error: `That is ${targets.length} things at once, and ${MOST_TARGETS} is the most one change may touch.`,
            note: "Ask for it in smaller pieces, so the merchant can read what they are agreeing to.",
          })
        );
      }

      const params = (args.params ?? {}) as Record<string, unknown>;
      const wrongHow = spec.check(targets, params);
      if (wrongHow) return ok(id, text({ error: wrongHow, what_can_be_asked_for: [ACTION_CATALOGUE.find((c) => c.action === wantedAction)] }));

      // What the store has actually allowed, when anybody has recorded
      // it. Null means nobody has looked since the grant, and refusing
      // on that would lock out every store connected before the column
      // existed — so the executor is left to find out instead.
      const { data: grantRow } = await db
        .from("stores")
        .select("granted_scopes")
        .eq("id", store.id)
        .maybeSingle();
      const granted = (grantRow?.granted_scopes ?? null) as string[] | null;
      const short = granted ? spec.scopes.filter((sc) => !granted.includes(sc)) : [];
      if (short.length) {
        return ok(
          id,
          text({
            error: `${store.shop_domain} has not allowed Warmluke to ${short.join(", ")}.`,
            note: "Nothing was asked for. The merchant reconnects the store in Warmluke to grant it, and then this can be proposed.",
            open: openAt(new URL(req.url).origin, store.project_id),
          })
        );
      }

      // The sentence on the card is written from the change itself,
      // never from the assistant. Whatever it told the merchant this
      // does, what they agree to is this line.
      const summary = spec.say(targets, params);
      const { data: actionId, error: proposeError } = await db.rpc("abo_action_propose", {
        p_project: store.project_id,
        p_store: store.id,
        p_action: wantedAction,
        p_targets: targets,
        p_params: params,
        p_summary: summary,
      });
      if (proposeError) return ok(id, text({ error: proposeError.message }));

      const where = openAt(new URL(req.url).origin, store.project_id, actionId as string);
      return ok(
        id,
        text({
          status: "waiting for the merchant",
          action_id: actionId,
          shop: store.shop_domain,
          changes: summary,
          touches: targets.length,
          ...(spec.undo
            ? { can_be_taken_back: true }
            : { cannot_be_taken_back: spec.undoNote ?? "This one cannot be undone." }),
          note: "Nothing has changed in the shop. Read them what this does, then read them what_the_merchant_does — and do not offer to do it for them, because you cannot.",
          what_the_merchant_does: stepsToFinishAction(
            { status: "pending", action: wantedAction },
            where,
            spec
          ),
          open: where,
        })
      );
    }

    if (name === "ask_store") {
      const question = String(args.question ?? "").trim();
      if (!question) return ok(id, text({ error: "What do you want to know? Pass question." }));
      const route = await routeQuestion(question);
      if (!route) {
        return ok(
          id,
          text({
            could_not_route: true,
            note: "That did not read as a question about one of the store's lists, or not clearly enough. Use store_overview, search_orders, get_order or search_store — or ask again naming the list (orders, customers, products, stock, sales) and the span.",
          })
        );
      }
      const slice = await fetchSlice(db, store, route);
      return ok(
        id,
        text({
          read_as: { list: route.list, window: route.window, month: route.month, kind: route.kind },
          ...(slice ?? { what: "nothing matched", rows: [], total: 0 }),
          note: "These rows were chosen from how the question read. Quote them; if they do not fit the question, use the specific tool instead of guessing.",
        })
      );
    }

    if (name === "store_overview") {
      // Counts, and the two lists a merchant asks for first. Whole-store
      // figures, unlike search_orders — say so when quoting them.
      const [overview, leaders, runs] = await Promise.all([
        storeOverview(db, store.id),
        storeLeaders(db, store.id),
        // Whether the copy is finished. A count read off a store that
        // is still importing is a true count of what has arrived and
        // a wrong answer to "how many do I have" — and there was no
        // way to tell the two apart from here.
        db.from("import_runs").select("resource, status, imported").eq("store_id", store.id),
      ]);
      const progress = (runs.data ?? []) as Array<{ resource: string; status: string; imported: number }>;
      const ranOf = (r: string) => progress.find((p) => p.resource === r);
      const unfinished = progress.filter((r) => r.status !== "done").map((r) => r.resource);

      // Rows held here that Shopify did not hand back on the last
      // full pass. The import route has worked this out since it was
      // written and shown it to the browser; a connected assistant
      // asked "is anything missing?" had no way to know, and said no.
      //
      // Only once every resource has finished. Part way through,
      // "more here than came back" is just the part that has not
      // arrived yet, and reporting it would cry wolf on every store
      // mid-import. Stock is excluded by the resource itself: its
      // pass counts variants while its table holds one row per
      // location, so the two were never comparable.
      const settled = RESOURCES.every((r) => ranOf(r)?.status === "done");
      const held = (overview?.counts ?? {}) as Record<string, number>;
      const drift = Object.fromEntries(
        RESOURCES.filter((r) => SHOPIFY_RESOURCES[r].drift)
          .map((r) => {
            const holding = held[SHOPIFY_RESOURCES[r].tables[0]] ?? 0;
            return [r, { holding, came_back: ranOf(r)?.imported ?? 0 }] as const;
          })
          .filter(([, v]) => v.holding > v.came_back)
      );

      return ok(
        id,
        text({
          ...overview,
          ...leaders,
          importing: Object.fromEntries(progress.map((r) => [r.resource, { status: r.status, imported: r.imported }])),
          note: "top_customers is lifetime spend as Shopify reports it; best_sellers counts every uncancelled order, paid or not. Both cover the whole store.",
          ...(unfinished.length
            ? {
                still_importing: `${unfinished.join(", ")} have not finished coming across. Say the counts are what has arrived so far, not the whole store.`,
              }
            : {}),
          ...(settled && Object.keys(drift).length
            ? {
                not_in_shopify_any_more: drift,
                // Never deleted here, and the reason is worth saying:
                // a pass that came back short looks exactly like a
                // deletion, and a wrong delete does not come back.
                drift_note:
                  "These are held here and did not come back from Shopify on the last full pass — most likely removed there while a webhook was not delivered. Nothing has been deleted. Tell the merchant the number and offer a recheck from the app rather than guessing which rows.",
              }
            : {}),
        })
      );
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
            available: Object.keys(STORE_TABLES),
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
