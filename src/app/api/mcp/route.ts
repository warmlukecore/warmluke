import { NextResponse, after } from "next/server";
import { reflectOnFeedback } from "@/lib/learning";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "@/lib/supabase-server";
import {
  STORE_TABLES,
  isStoreTable,
  listStores,
  ownColumns,
  readStorePage,
  readStoreRows,
  storeSectionColumns,
  storeSignals,
  withOwnFields,
} from "@/lib/store-read";
import { asksFromStore } from "@/lib/suggest";
import { viewEditPlans, type ViewEdit } from "@/lib/view-edit";
import { PROMPTS, guideFor, guideVersion, outcomeOf, promptFor, type ToolLine } from "@/lib/client-guide";
import { blueprintAsText, runTurn, schemasFor, storeFactsFor } from "@/lib/engine";
import { describeBuild } from "@/lib/judge";
import { DESIGN_VIEW_MIME, DESIGN_VIEW_URI, designViewHtml, type ViewDesign } from "@/lib/design-view";
import { projectFormat } from "@/lib/money";
import { CODE_RULE_GUIDE, CUSTOM_VIEW_GUIDE, PLAN_FORMAT, WORKED_EXAMPLE, findGaps, parseReply } from "@/lib/ai";
import { vocabularyPrompt } from "@/lib/capabilities";
import { abilitiesPrompt } from "@/lib/abilities";
import {
  describePlan,
  describeRules,
  retypedCopies,
  sectionTwin,
  seededCopies,
  stepsToFinish,
  stepsToFinishAction,
  type RuleRow,
} from "@/lib/describe";
import { actionSpec } from "@/lib/store-actions";
import { applyPlans, logClientBuild, putBack } from "@/lib/apply";
import { undoableFrom } from "@/lib/undo";
import { STORE_TOOLS, storeTool, type StoreTool } from "@/lib/store-tools";
import { tapeHeaders } from "@/lib/model-tape";
import { builtLine, openAt, removals, settleDesign, text, type Json } from "@/lib/client-design";
import { answerFor, answerWhenReady } from "@/lib/client-turn";
import { TOKEN_LEFT_MS, finishTurn, lapsesAt, settleAnswer, turnContext, type TurnJob } from "@/lib/turn-run";
import { start } from "workflow/api";
import { lukeTurn } from "@/workflows/luke-turn";
import { ACTION_CATALOGUE, PROPOSE_INPUT, proposeStoreAction } from "@/lib/store-action-propose";
import { ALLOWED_ICONS } from "@/lib/types";
import type { AssistantPlan, ModuleRow, NextStep, ProjectRow, SchemaColumn, UiSchema } from "@/lib/types";

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

/**
 * How long propose_change waits for its design before answering "still
 * designing": under the minute a client is commonly given for a tool.
 */
const DESIGN_WAIT_MS = Number(process.env.MCP_DESIGN_WAIT_MS) || 40_000;
/** Designs their AI draws that Luke checks, each app, each day (5 Oct): past it, the validator alone. */
const DRAWN_REVIEWED_A_DAY = 20;

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

/** Which store, for the tools that read one: MCP's own question, never the tool's. */
const SHOP_DOMAIN = {
  type: "string",
  description: "Which store, when the account has more than one. Optional.",
} as const;

/** A shared store tool as an MCP client is sent it: which store, and how to draw it. */
const forMcp = (t: StoreTool) => ({
  name: t.name,
  description: t.description + RENDER_NOTE,
  inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, shop_domain: SHOP_DOMAIN } },
});

const TOOLS = [
  // The store's reading tools, declared once in store-tools and shared with Luke.
  ...STORE_TOOLS.map(forMcp),
  {
    name: "how_to_help",
    description:
      "Read this first: how to help this merchant well, as Warmluke's own designer does, which tool is for what, and what it has learned about how they work. The same guide this server gives when you connect, for an assistant that did not read it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_section",
    description:
      "How a section in the merchant's Warmluke app is put together — its fields, its filters, its stats, where its rows come from — and its rows when it holds its own. Call it with no arguments to list the sections. Use this before guessing why something on screen behaves the way it does." +
      RENDER_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The section's name, as listed." },
        history: {
          type: "boolean",
          description:
            'Return how this section has changed instead of its rows: every version, newest first, with when it was made, who by, and the fields it held. Use it to answer "what did this look like before?" and to propose putting it back.',
        },
        limit: { type: "number", description: "Up to 200. Defaults to 50." },
        project_id: { type: "string", description: "Which app, when they have more than one." },
      },
    },
  },
  {
    name: "propose_change",
    // Drawn beside the answer by a host that speaks MCP Apps (lib/design-view).
    _meta: { ui: { resourceUri: DESIGN_VIEW_URI }, "openai/outputTemplate": DESIGN_VIEW_URI },
    description:
      "Ask for something to be built or changed in the merchant's Warmluke app — a new section, a rule, a fix. Describe the problem in their own words, not a database design. Warmluke's Luke designs it in a conversation of its own in the merchant's app. The answer is the design (built already if the merchant turned on automatic builds; otherwise read it back and, if they approve, call approve_change), questions to ask them (then call this again with their answers and the conversation_id), or \"still designing\" (call pending_changes in a minute or two).",
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
        conversation_id: {
          type: "string",
          description:
            "The conversation_id an earlier answer gave, to carry on in it: answers to its questions, or a change to what it designed. Leave it out for something new.",
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
      'What has actually been built in this app, newest first — including the ones that only partly worked, and what did not. Use it to answer "what changed last week?", to check whether something was already done before proposing it again, and to see whether an earlier build left anything unfinished.',
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
    // Drawn beside the answer by a host that speaks MCP Apps (lib/design-view).
    _meta: { ui: { resourceUri: DESIGN_VIEW_URI }, "openai/outputTemplate": DESIGN_VIEW_URI },
    description:
      "Submit a design you wrote yourself. Warmluke puts it through every check its own designs go through. What its validator refuses comes back as a list of what is wrong, for you to correct and submit again. A design that holds is then checked against what the merchant asked for and by reviewers for a simpler build, the store's real rows, the rules tried on them and the screens, and Luke fixes what they find, knowing the business, before it goes in front of the merchant for approval exactly like propose_change does. The answer says under checked_by_luke whether Luke changed it, and why. It can take a minute; past that you get a conversation_id, and pending_changes has the result. It does not use one of the merchant's included designs. To find problems yourself first, free and at once, call validate_design.",
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
    name: "edit_view",
    _meta: { ui: { resourceUri: DESIGN_VIEW_URI }, "openai/outputTemplate": DESIGN_VIEW_URI },
    description:
      "Change how a section looks, with nothing designed and nothing charged: rename its columns, take one off the table or put it back (a column off the table is still in the row when it is opened), put them in another order, choose which columns are filters above the table, and the order its rows open in. The same as Customize in Warmluke. Call read_section first for its columns. It goes in front of the merchant as any change does: built at once if they turned on automatic builds, otherwise read it back and call approve_change. A filter offers the values its column's rows hold, and a yes/no column Yes and No; what cannot be a filter comes back with why. For a new field, a rule, or a change to what the section does, use propose_change.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The section's name, as read_section lists it." },
        columns: {
          type: "array",
          description:
            "Columns in the order to show them, each { field, label?, hidden? }. One left out keeps its name and comes after these. Leave the list out to keep the columns as they are.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              label: { type: "string", description: "Its new name. Leave out to keep it." },
              hidden: { type: "boolean", description: "true takes it off the table; false puts it back." },
            },
            required: ["field"],
          },
        },
        filters: {
          type: "array",
          items: { type: "string" },
          description: "The fields to filter by, in order: the whole list, [] for none. Leave out to keep them.",
        },
        sort: {
          description:
            'The order rows open in: { "field": "<a column>", "dir": "asc" | "desc" }, or null for the order they came in. Leave out to keep it.',
          anyOf: [
            {
              type: "object",
              properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } },
              required: ["field"],
            },
            { type: "null" },
          ],
        },
        request: {
          type: "string",
          description: "What the merchant asked for, in their own words, for the approval card. Optional.",
        },
        project_id: { type: "string", description: "Which app, when they have more than one. Optional." },
      },
      required: ["section"],
    },
  },
  {
    name: "propose_store_action",
    description:
      "Ask for something to be changed IN the merchant's Shopify shop itself — a tag on some orders, a note, a stock count. Warmluke writes the sentence they will read, from the change, not from you. Nothing happens until they agree to it in Warmluke, and you cannot agree for them: a change to a live shop is theirs alone, whatever the app's auto-build setting says. Call it once per kind of change; the answer says what they have to do next. What can be asked for: " +
      ACTION_CATALOGUE.map((c) => `${c.action} (${c.does})`).join(", ") +
      ".",
    inputSchema: {
      ...PROPOSE_INPUT,
      properties: {
        ...PROPOSE_INPUT.properties,
        shop_domain: { type: "string", description: "Which store, when there is more than one." },
        project_id: { type: "string", description: "Which app, when they have more than one. Optional." },
      },
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

/** The tools as the guide names them (lib/client-guide), and which guide that makes. */
const TOOL_LINES: ToolLine[] = TOOLS.map((t) => ({ name: t.name, description: t.description }));
const GUIDE_VERSION = guideVersion(TOOL_LINES);

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
      (r.status === "pending" || r.status === "building") && (client === null || r.client_id === client),
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

/** How far back pending_changes looks for an ask that is not a request yet. */
const ASKS_SHOWN_MS = 48 * 3600_000;

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

/**
 * An ask's turn run in this request's function, when it cannot run
 * durably: the same turn, read and ended the same way (lib/client-turn),
 * and its charge given back unless it wrote a request down.
 */
/**
 * An ask of the merchant's own AI, run as Luke's turn in a thread of its
 * own (0139) and waited on a while: propose_change asks in words, and
 * submit_design with the design its AI drew as well, which Luke's loop
 * reads as its first attempt and checks as it checks its own (5 Oct).
 * The answer is what the tool replies with.
 */
async function askInThread(
  req: Request,
  db: SupabaseClient,
  userId: string,
  project: ProjectRow,
  request: string,
  ask: { conversationId: string | null; spendId: string | null; design?: string }
): Promise<Json> {
  const origin = new URL(req.url).origin;
  // The charge, given back unless a run takes it over: the durable run
  // gives it back itself, and the one run here in runHere.
  let refundable: string | null = ask.spendId;
  let started = false;
  let job: TurnJob;
  try {
    const { data: opened, error: openErr } = await db.rpc("abo_client_ask", {
      p_project: project.id,
      p_request: request,
      p_conversation: ask.conversationId,
    });
    if (openErr || !opened) {
      return text({ error: openErr?.message ?? "Warmluke could not start this conversation." });
    }
    const o = opened as {
      conversation_id: string;
      asked_id: string;
      answer_id: string;
      asked_at: string;
      new: boolean;
      /** The same words moments ago (0139): that ask is waited on, and nothing starts twice. */
      again?: boolean;
    };
    job = {
      userId,
      projectId: project.id,
      moduleId: null,
      conversationId: o.conversation_id,
      askedId: o.asked_id,
      answerId: o.answer_id,
      message: request,
      askedModel: null,
      askedAt: Date.parse(o.asked_at),
      isNewConversation: o.new,
      client: { origin },
      ...(ask.design ? { design: ask.design } : {}),
    };
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    // Asked again (a retry): its first ask is running or done, so nothing
    // starts, and this charge goes back in `finally`.
    if (o.again) {
      /* waited on below */
    } else if (process.env.LUKE_WORKFLOW === "1" && lapsesAt(token) - Date.now() > TOKEN_LEFT_MS) {
      try {
        await start(lukeTurn, [{ ...job, token, spendId: refundable }]);
        started = true;
        refundable = null;
      } catch (e) {
        console.error(`[mcp] durable turn not started, running here: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Not durable (switched off, a token too near its end, a run that
    // would not start): run here, held open past this answer. Known by
    // its start, not by a charge left over: a drawn design has none (5 Oct).
    if (!o.again && !started) {
      const here = runHere(db, project, job, refundable);
      refundable = null;
      after(() => here);
    }
  } finally {
    if (refundable) await db.rpc("abo_refund_turn", { p_spend: refundable });
  }

  const line = await answerWhenReady(db, job.answerId, DESIGN_WAIT_MS);
  if (line) return answerFor(line, job.conversationId);
  // Past the wait: said so, and the turn goes on in the merchant's panel.
  return {
    ...text({
      status: "still designing",
      conversation_id: job.conversationId,
      note: `Warmluke is still designing this, in a conversation of its own in the merchant's Luke panel, and keeps going without you. Call pending_changes in a minute or two: it says whether this is still being designed, has a question for the merchant, or failed, and a finished design is listed there as a request. ${
        project.auto_build === true
          ? "This app builds designs as they arrive, so it may already be built by then."
          : "Nothing is built until the merchant says yes."
      }`,
      open: openAt(origin, project.id),
    }),
    structuredContent: {
      design: {
        status: "designing",
        request,
        open: openAt(origin, project.id),
        format: projectFormat(project, null),
        parts: [],
      } satisfies ViewDesign,
    },
  };
}

async function runHere(db: SupabaseClient, project: ProjectRow, job: TurnJob, spend: string | null): Promise<void> {
  let charged = false;
  try {
    const ctx = await turnContext(db, project, {
      projectId: job.projectId,
      moduleId: null,
      conversationId: job.conversationId,
      before: new Date(job.askedAt).toISOString(),
      userId: job.userId,
    });
    // The turn this door has always run: plain plans allowed, nothing looked up.
    const turn = await runTurn({
      client: db,
      project,
      modules: ctx.moduleList,
      message: job.message,
      history: ctx.history,
      currentSchema: ctx.currentSchema,
      currentFeatures: ctx.currentFeatures,
      blueprintShown: ctx.blueprintShown,
      plansAllowed: true,
      // One check for every design, whoever writes it (5 Oct).
      reviewed: true,
      givenDesign: job.design,
    });
    const done = await finishTurn(db, job, ctx, turn, null, [], (fn) => after(fn));
    charged = done.charged;
  } catch (e) {
    const why = e instanceof Error ? e.message : "The turn could not go on.";
    console.error(`[mcp] an ask's turn failed: ${why}`);
    await settleAnswer(db, job, {
      type: "unanswered",
      message: why,
      mcp: text({ error: why, conversation_id: job.conversationId }),
    }).catch(() => false);
  } finally {
    if (!charged && spend) await db.rpc("abo_refund_turn", { p_spend: spend });
  }
}

const ok = (id: RpcRequest["id"], result: Json) =>
  // tapeHeaders: whether model calls are recorded or played back here; nothing in production.
  NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: tapeHeaders() });

const rpcError = (id: RpcRequest["id"], code: number, message: string) =>
  NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * A call, recorded with the guide that was current (0180), and what came
 * of it read off the answer after it has gone, for the console's Their AI
 * screen. Nothing here decides the answer.
 */
export async function POST(req: Request) {
  const seen: Seen = {};
  const res = await handle(req, seen);
  const { db, callId } = seen;
  if (db && callId) {
    after(async () => {
      const { outcome, problems } = outcomeOf(
        await res
          .clone()
          .json()
          .catch(() => null)
      );
      await db.rpc("abo_mcp_outcome", { p_id: callId, p_outcome: outcome, p_problems: problems });
    });
  }
  return res;
}

/** What the call left to note once it is answered: the row it was recorded as. */
type Seen = { db?: SupabaseClient; callId?: number };

/**
 * Records a call and says whether it was allowed: with the guide and the
 * row's id since 0180, as before it until that has run.
 */
async function record(db: SupabaseClient, tool: string, seen: Seen) {
  const now = await db.rpc("abo_mcp_record", { p_tool: tool, p_guide: GUIDE_VERSION });
  if (!now.error) {
    const id = (now.data as { id?: number } | null)?.id;
    if (typeof id === "number") Object.assign(seen, { db, callId: id });
    return now;
  }
  return db.rpc("abo_mcp_call", { p_tool: tool });
}

/** A call that is not a tool's, recorded with what it came to at once: a connection, a prompt asked for. */
async function noteNow(db: SupabaseClient, tool: string, outcome: string) {
  const seen: Seen = {};
  await record(db, tool, seen);
  if (seen.callId) await db.rpc("abo_mcp_outcome", { p_id: seen.callId, p_outcome: outcome, p_problems: null });
}

async function handle(req: Request, seen: Seen) {
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
    // A token that was sent and refused (signed out, disconnected) is
    // said as such (RFC 6750), so the client offers to sign in again
    // rather than reporting "internal error", as ChatGPT did.
    const refused = /^bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: refused ? "This sign-in has ended. Connect Warmluke again." : "Sign in to use this server.",
        },
      },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": refused
            ? `Bearer error="invalid_token", resource_metadata="${meta}"`
            : `Bearer resource_metadata="${meta}"`,
        },
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
    // Which guide each connection was given, for the console (0180).
    after(() => noteNow(db, "initialize", "connected"));
    // Negotiation proper: speak the client's revision when it is one we
    // were written against, otherwise name ours and let it decide.
    const asked = (params as { protocolVersion?: string }).protocolVersion;
    return ok(id, {
      protocolVersion: asked && KNOWN.has(asked) ? asked : LATEST_KNOWN,
      // Tools, and the page a host that speaks MCP Apps draws beside a design (lib/design-view).
      capabilities: {
        tools: {},
        resources: {},
        // Ready-made asks whose words come from the store's own numbers (lib/client-guide).
        prompts: {},
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [DESIGN_VIEW_MIME] } },
      },
      serverInfo: { name: "warmluke", version: "0.1.0" },
      // The first thing every connected assistant reads: how to help them,
      // from what Luke works to, and their own app and what Luke has learned
      // there (lib/client-guide). What the shop allows still comes off the
      // registry, so it stays true as actions are added.
      instructions: await guideFor(db, TOOL_LINES),
    });
  }

  if (method === "ping") return ok(id, {});
  if (method === "prompts/list") {
    return ok(id, {
      prompts: PROMPTS.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        ...(p.arguments ? { arguments: p.arguments } : {}),
      })),
    });
  }
  if (method === "prompts/get") {
    const { name: asked, arguments: given } = params as { name?: string; arguments?: Record<string, unknown> };
    const args = Object.fromEntries(Object.entries(given ?? {}).map(([k, v]) => [k, String(v ?? "")]));
    const found = await promptFor(db, String(asked ?? ""), args);
    if (found) after(() => noteNow(db, `prompt:${found.prompt.name}`, "asked"));
    if (!found) return rpcError(id, -32602, `No prompt "${asked}".`);
    const missing = (found.prompt.arguments ?? []).filter((a) => a.required && !args[a.name]?.trim());
    if (missing.length) return rpcError(id, -32602, `Say ${missing.map((a) => a.name).join(" and ")}.`);
    return ok(id, {
      description: found.prompt.description,
      messages: [{ role: "user", content: { type: "text", text: found.text } }],
    });
  }
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  // The design's preview: one page, the same for every design, which draws what each answer carries.
  if (method === "resources/list") {
    return ok(id, {
      resources: [
        {
          uri: DESIGN_VIEW_URI,
          name: "Design preview",
          description: "A Warmluke design drawn: each part, its fields and a few rows, and a written screen.",
          mimeType: DESIGN_VIEW_MIME,
        },
      ],
    });
  }
  if (method === "resources/read") {
    const uri = (params as { uri?: string }).uri;
    if (uri !== DESIGN_VIEW_URI) return rpcError(id, -32002, `No resource "${uri}".`);
    return ok(id, {
      contents: [{ uri, mimeType: DESIGN_VIEW_MIME, text: designViewHtml(), _meta: { ui: { prefersBorder: true } } }],
    });
  }

  if (method !== "tools/call") {
    return rpcError(id, -32601, `No method "${method}".`);
  }

  const { name, arguments: args = {} } = params as { name?: string; arguments?: Json };

  // Counted before the work, not after: the point is to stop a client
  // in a loop, and a limiter that only notices once the reads have
  // happened has already paid for them. The same row is the record of
  // what the assistant asked for.
  const { data: allowance, error: callErr } = await record(db, name ?? "?", seen);
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
      const project = wantedProject ? list.find((p) => p.id === wantedProject) : list.length === 1 ? list[0] : null;
      if (!project) {
        return ok(
          id,
          text({
            error: list.length ? "Which app is this for? Pass project_id." : "This account has no app yet.",
            projects: list.map((p) => ({ id: p.id, name: p.name })),
          })
        );
      }

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
      const { data: allowance, error: spendErr } = await db.rpc("abo_spend_turn", { p_project: project.id });
      if (spendErr) throw new Error(spendErr.message);
      const turns = allowance as { ok: boolean; used: number; free: number; spend_id?: string } | null;
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
            note: "That counter is only for designs Warmluke writes. Write this one yourself instead: call design_format, then submit_design. It goes through the same checks, to the merchant the same way, and does not touch the counter.",
            do_this_instead: "design_format",
            reading_still_works:
              "orders, stock, products, customers — and pending_changes says what, if anything, is still waiting to be approved",
            open: openAt(new URL(req.url).origin, project.id),
          })
        );
      }

      // Asked in a thread of its own in Luke's panel, and run as Luke's
      // turn is (0139, lib/client-turn): durable past any one function's
      // time, and ended however it ends — a design, settled as a request
      // and built if the merchant said it may be; a question for them; or
      // why it failed — on a line this answer, or a later one, reads.
      // It used to be designed inside this request and kept only if it
      // finished here as a design: three asks from ChatGPT in one evening
      // ended in a question, an empty reply and a timeout, and not one of
      // them left anything behind.
      return ok(
        id,
        await askInThread(req, db, auth.userId, project, request, {
          conversationId: (args.conversation_id as string | undefined)?.trim() || null,
          spendId: turns.spend_id ?? null,
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
      const project = wanted ? list.find((p) => p.id === wanted) : list.length === 1 ? list[0] : null;
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
            // What this store's own numbers make worth building, as Luke's
            // empty panel offers it (lib/suggest.ts, 5 Oct): an ask to pass
            // to propose_change, and the number behind it. None for a need a
            // section already meets.
            suggested_from_the_store: await (async () => {
              const { data: store } = await db.from("stores").select("id").eq("project_id", project.id).maybeSingle();
              if (!store) return [];
              const signals = await storeSignals(db, store.id as string);
              return asksFromStore(
                signals,
                sections.map((m) => m.nav_label)
              ).map((a) => ({ ask: a.prompt, because: a.label }));
            })(),
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

      const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);
      if (section.source_table) {
        const src = section.source_table;
        const searching = `Its rows are the store's ${src} — search them with search_store, table "${src}".`;
        const { data: st } = await db
          .from("stores")
          .select("id")
          .eq("project_id", project.id)
          .in("status", ["connected", "uninstalled"])
          .maybeSingle();
        if (!isStoreTable(src) || !st) return ok(id, text({ ...setup, note: searching }));
        // The section as the merchant sees it: the store's rows, in the
        // section's order, with what they keep beside each (0128).
        const columns = storeSectionColumns(src, sj.columns as SchemaColumn[] | undefined);
        const sort = (sj.features as { defaultSort?: { field: string; dir: "asc" | "desc" } } | null)?.defaultSort;
        const { rows, total } = await readStoreRows(db, st.id as string, src, limit, undefined, sort ?? null);
        const laid = await withOwnFields(db, section.id, rows);
        const theirs = ownColumns(src, columns).filter((c) => !c.compute);
        return ok(
          id,
          text({
            ...setup,
            fields: columns.map((c) => ({ field: c.field, label: c.label, type: c.type })),
            total,
            showing: laid.length,
            rows: laid.map((r) => r.data),
            note: `${searching} The merchant's own fields, kept here beside each row where no import reaches: ${
              theirs.map((c) => c.field).join(", ") || "none yet"
            }.`,
          })
        );
      }

      const { data: rows, count } = await db
        .from("records")
        .select("data", { count: "exact" })
        .eq("module_id", section.id)
        // Fields kept beside a store row are not rows of the section's own.
        .is("store_row_id", null)
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

      // What this assistant asked for that is not a request yet: still
      // being designed, a question waiting on the merchant, or a turn
      // that failed (lib/client-turn). Without these, a design still
      // under way read as nothing at all, and was asked for again.
      const since = new Date(Date.now() - ASKS_SHOWN_MS).toISOString();
      let askQuery = db
        .from("conversations")
        .select(
          "id, project_id, title, updated_at, messages(role, created_at, via:payload->>via, ptype:payload->>type, message:payload->>message, questions:payload->questions)"
        )
        .not("asked_by", "is", null)
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(SHOW_WAITING);
      askQuery = client ? askQuery.eq("asked_client", client) : askQuery.is("asked_client", null);
      if (wanted) askQuery = askQuery.eq("project_id", wanted);
      const { data: askRows } = await askQuery;
      type AskLine = {
        role: string;
        created_at: string;
        via: string | null;
        ptype: string | null;
        message: string | null;
        questions: unknown;
      };
      const asks = (askRows ?? []).flatMap((c) => {
        const lines = ((c.messages ?? []) as AskLine[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
        const last = lines.find((m) => m.role === "assistant");
        const where = openAt(new URL(req.url).origin, c.project_id);
        const base = { conversation_id: c.id, asked: c.title, open: where };
        // The merchant took it on with Luke in Warmluke, answering its
        // questions there: what Luke says next is theirs, and whatever they
        // build shows in build_history.
        if (lines.find((m) => m.role === "user")?.via !== "client")
          return [
            {
              ...base,
              state: "carried on in Warmluke",
              next_action:
                "The merchant carried this on with Luke in Warmluke. Do not ask for it again; build_history shows what they built.",
            },
          ];
        if (last?.ptype === "answering") return [{ ...base, state: "still designing" }];
        if (last?.ptype === "clarify")
          return [
            {
              ...base,
              state: "needs answers",
              message: last.message,
              questions: last.questions,
              next_action:
                "Ask the merchant these, then call propose_change with their answers and this conversation_id. They may answer in Warmluke instead.",
            },
          ];
        if (last?.ptype === "unanswered") return [{ ...base, state: "failed", why: last.message }];
        return [];
      });
      return ok(
        id,
        text({
          // rows.length alone read as the whole truth once the queue
          // grew past a page of it.
          total,
          showing: rows.length,
          ...(total > rows.length ? { has_more: `${total - rows.length} older ones are not listed here.` } : {}),
          ...(asks.length
            ? {
                your_asks: asks,
                your_asks_note:
                  "What you asked propose_change for that is not a request yet. A design still being made lands here as a request when it is done; do not ask for it again.",
              }
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
            : asks.length
              ? "Nothing is waiting for approval yet. What you asked for is in your_asks: say what state each is in."
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
              what_the_merchant_does: stepsToFinish(
                { ...(r as RequestRow), plans: (r as RequestRow).plans ?? [] },
                where
              ),
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
        .select("id, project_id, request, summary, status, approved_at, created_at, built_at, client_id, outcome")
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
      const answer = said as { rejected: boolean; already?: boolean; status?: string; reason?: string } | null;

      // Turned down: Luke learns from it as from a thumbs down on the
      // design the ask was answered with (5 Oct).
      if (answer?.rejected && !answer.already) {
        const { data: line } = await db
          .from("messages")
          .select("id")
          .eq("role", "assistant")
          .eq("payload->>request_id", requestId)
          .limit(1)
          .maybeSingle();
        if (line)
          after(() =>
            reflectOnFeedback(db, {
              messageId: line.id as string,
              verdict: "down",
              note: reason ? `The owner turned this design down: ${reason}` : "The owner turned this design down.",
            })
          );
      }

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
          // Where each thing works and what it promises: what Luke is told too (lib/abilities).
          what_runs_where: abilitiesPrompt(),
          allowed_icons: ALLOWED_ICONS,
          worked_example: WORKED_EXAMPLE,
          two_things_that_get_guessed_wrong: [
            'The operator key is "op", never "operator" or "type": { "op": "<=", "args": [ { "field": "available" }, { "const": 5 } ] }.',
            '"view" belongs inside "features", not inside "newSchema".',
          ],
          store_backed_sections:
            "A section with source_table shows Shopify's own rows, and is how work on those rows is built (packing orders, restocking products), never a second list of them typed in by hand. The store's columns are filled in: in newSchema send only what you add — a computed column, or a field of the merchant's that sits beside each row (\"packed\", \"shelf\"), which no import touches. The store's own fields are never written: buttons, scans and rules on such a section set the merchant's fields, and a rule there runs on record_updated and reads those fields only.",
          // Named, because "the columns are the store's" told a client
          // nothing it could type. It guessed Shopify's API names —
          // total_price, created_at, fulfillment_status — and was
          // refused seven times over for a section it had not built
          // yet. These are the names, per table, and they do not
          // change.
          // What each list is, in the same words Luke reads — so a
          // client asked for "a SKU list for my orders" finds the list
          // that already is one, instead of building a hand-typed copy.
          // How a row is made from another (lib/links.ts, 5 Oct): what the
          // merchant's form does with a link, so a client builds the section
          // and not a written screen that picks a row and copies it.
          linked_rows:
            "A \"link\" column to another section (the store's orders and their items too) is how a row is made from another: in the row form the merchant searches that section, and choosing a row fills this section's fields of the same name or label (customer, phone, total), never what they typed. A second link to a list under it (an order's items) offers that row's items alone. Build a section with links rather than a written screen that picks a row and copies its fields.",
          store_lists: Object.fromEntries(Object.entries(STORE_TABLES).map(([table, spec]) => [table, spec.what])),
          store_columns: Object.fromEntries(
            Object.entries(STORE_TABLES).map(([table, spec]) => [table, spec.columns.map((c) => c.field)])
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
          // The same guides Luke designs by, from the same constants, so a
          // screen or a rule's code written here is written to the same
          // contract the app runs it under. "CONTEXT" in them is the
          // sections read_section lists.
          written_screens: CUSTOM_VIEW_GUIDE,
          code_rules: CODE_RULE_GUIDE,
          context_means:
            "Where these guides say CONTEXT, they mean the app's sections: call read_section to list them and their fields.",
        })
      );
    }

    if (name === "how_to_help") {
      return ok(id, text({ guide: await guideFor(db, TOOL_LINES), version: GUIDE_VERSION }));
    }

    if (name === "edit_view") {
      // Refused before anything is read (the AI stack's rule 8).
      if (!String(args.section ?? "").trim()) return ok(id, text({ error: "Which section? Pass section." }));
      for (const [part, ok_] of [
        ["columns", args.columns === undefined || Array.isArray(args.columns)],
        ["filters", args.filters === undefined || Array.isArray(args.filters)],
        ["sort", args.sort === undefined || args.sort === null || typeof args.sort === "object"],
      ] as const)
        if (!ok_) return ok(id, text({ error: `${part} is not in the shape edit_view takes: see its description.` }));
      const { data: projects } = await db.from("projects").select("*");
      const list = (projects ?? []) as ProjectRow[];
      const wantedProject = (args.project_id as string | undefined)?.trim();
      const project = wantedProject ? list.find((p) => p.id === wantedProject) : list.length === 1 ? list[0] : null;
      if (!project) {
        return ok(
          id,
          text({
            error: list.length ? "Which app is this for? Pass project_id." : "This account has no app yet.",
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
      const asked = String(args.section ?? "")
        .trim()
        .toLowerCase();
      const section =
        moduleList.find((m) => m.nav_label.toLowerCase() === asked) ??
        moduleList.find((m) => m.name.toLowerCase() === asked);
      if (!section) {
        return ok(
          id,
          text({
            error: `No section called "${args.section}".`,
            sections: moduleList.map((m) => m.nav_label),
          })
        );
      }
      const schema = (await schemasFor(db, [section])).get(section.id);
      if (!schema) return ok(id, text({ error: `"${section.nav_label}" has no columns to change.` }));

      const edit: ViewEdit = {
        ...(Array.isArray(args.columns) ? { columns: args.columns as ViewEdit["columns"] } : {}),
        ...(Array.isArray(args.filters) ? { filters: (args.filters as unknown[]).map(String) } : {}),
        ...(args.sort !== undefined ? { sort: args.sort as ViewEdit["sort"] } : {}),
      };
      // What a filter could offer: the values its rows hold, the whole
      // store list's for a section over the store.
      const asks = edit.filters ?? [];
      const values = new Map<string, string[]>();
      if (asks.length) {
        if (isStoreTable(section.source_table)) {
          const page = await readStorePage(
            db,
            section.id,
            section.source_table,
            { page: 0, size: 25, search: "", filters: {}, sort: null },
            schema.features ?? null,
            schema.columns,
            null,
            asks
          );
          for (const [f, v] of Object.entries(page.facets)) values.set(f, v);
        } else {
          const { data: rows } = await db.from("records").select("data").eq("module_id", section.id).limit(500);
          for (const f of asks)
            values.set(
              f,
              (rows ?? []).flatMap((r) => {
                const v = (r.data as Record<string, unknown> | null)?.[f];
                return Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
              })
            );
        }
      }
      const { plans, said, errors } = viewEditPlans(section.id, schema, edit, (f) => values.get(f) ?? []);
      if (errors.length) {
        return ok(
          id,
          text({
            status: "not accepted",
            errors,
            note: "Nothing has been requested or changed. Correct these and call edit_view again.",
          })
        );
      }
      if (plans.length === 0) {
        return ok(id, text({ status: "nothing to change", note: `"${section.nav_label}" already looks like that.` }));
      }
      const request = String(args.request ?? "").trim() || `${section.nav_label}: ${said.join("; ")}`;
      const settled = await settleDesign({
        db,
        origin: new URL(req.url).origin,
        project,
        moduleList,
        plans,
        design: blueprintAsText({ type: "plans", plans }, moduleList, null, []),
        unmet: [],
        request,
        store: null,
        later: (fn) => after(fn),
      });
      return ok(id, settled.answer);
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
      const project = wantedProject ? list.find((p) => p.id === wantedProject) : list.length === 1 ? list[0] : null;
      if (!project) {
        return ok(
          id,
          text({
            error: list.length ? "Which app is this for? Pass project_id." : "This account has no app yet.",
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
      // Its rules too, so a field one still reads is not taken away, and a
      // rule turned off that another waits on is said (heads_up).
      const { data: ruleRows } = await db
        .from("automations")
        .select("module_id, name, enabled, definition")
        .eq("project_id", project.id);
      const checked = parseReply(
        JSON.stringify({ plans: given }),
        moduleList,
        null,
        null,
        (moduleId) => schemas.get(moduleId) ?? null,
        (moduleId) => (ruleRows ?? []).filter((r) => r.module_id === moduleId)
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
      const plans = checked.reply.type === "blueprint" ? checked.reply.blueprint.plans : checked.reply.plans;

      // Made-up rows beside the store's own are refused here as they
      // are in Luke's own loop: a client once seeded four invented
      // order lines into a copy of the order items, and they sat next
      // to the real orders looking like data.
      const facts = await storeFactsFor(db, project.id);
      const copies = seededCopies(plans, facts);
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
        // What the merchant should be asked before this is sent: work on
        // rows a section of theirs already works on, or a second list of
        // the store's typed in by hand. Not refused: the card is theirs to
        // decide on, and a connected assistant can ask them first.
        const heads_up = [
          ...plans.flatMap((pl) => {
            const twin = sectionTwin(pl, moduleList, (mid) => schemas.get(mid)?.columns);
            return twin
              ? [
                  `"${twin.nav_label}" [id ${twin.id}] already works on these rows. Ask the merchant whether this belongs in it — then FIELD_ADD or FEATURE_UPDATE on that id — or is a section of its own over the same rows.`,
                ]
              : [];
          }),
          ...retypedCopies(plans, facts),
          ...plans.flatMap((pl) => pl.heads_up ?? []),
        ];
        return ok(
          id,
          text({
            status: "holds",
            note: "Nothing was requested and the merchant has seen nothing. Call submit_design with these same plans to put it in front of them.",
            would_build: plans.map((pl) => describePlan(pl, moduleList)),
            ...(heads_up.length ? { heads_up } : {}),
          })
        );
      }

      const request =
        String(args.request ?? "").trim() ||
        // The card is read by a person who has to recognise what they
        // asked for. Falling back to the design's own words beats an
        // empty line.
        plans
          .map((pl) => pl.explanation)
          .filter(Boolean)
          .join(" ") ||
        "A change designed by their own assistant";

      // A design that holds goes through what Luke's own go through (5 Oct):
      // run as Luke's turn with it as the first attempt, so the critic and
      // the reviewers read it, and what they find Luke fixes, knowing the
      // business as their AI cannot. What the validator refuses went back
      // above to the assistant that wrote it: its own shape to fix, free and
      // at once. Up to a number a day for each app, as this door costs the
      // merchant nothing; past it, as before.
      const { count: today } = await db
        .from("build_requests")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .not("client_id", "is", null)
        .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
      if ((today ?? 0) < DRAWN_REVIEWED_A_DAY) {
        return ok(
          id,
          await askInThread(req, db, auth.userId, project, request, {
            conversationId: (args.conversation_id as string | undefined)?.trim() || null,
            spendId: null,
            design: JSON.stringify({ type: "plans", plans }),
          })
        );
      }

      // What they asked for that this does not do, said as Luke's own
      // designs say it: the same gap pass, over the merchant's words when
      // the assistant passed them. Without their words there is nothing
      // to hold the design against. A pass that fails says nothing.
      const ownerWords = String(args.request ?? "").trim();
      const unmet = ownerWords
        ? await findGaps(ownerWords, describeBuild(plans, moduleList, undefined, facts, { screens: true }))
        : [];

      const settled = await settleDesign({
        db,
        origin: new URL(req.url).origin,
        project,
        moduleList,
        plans,
        design: blueprintAsText({ type: "plans", plans }, moduleList, null, unmet),
        unmet,
        request,
        store: null,
        later: (fn) => after(fn),
      });
      return ok(id, settled.answer);
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
            note: 'The merchant can put it back themselves: its receipt in Warmluke has a "Put it back" link.',
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
            note: 'This app asks before it changes anything, and an undo is a change. Tell them the fastest way is the build\'s own receipt in Warmluke, which has a "Put it back" link on it.',
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
        return ok(
          id,
          text({ status: "already built", note: "This design was already applied. Nothing was built again." })
        );
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
        return ok(
          id,
          text({ error: "The merchant dismissed this request. Propose it again if they changed their mind." })
        );
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
            error: "Warmluke needs the merchant's yes from inside their own app before this is built.",
            note: "Tell them it is waiting in Warmluke — the bell in the assistant panel. If they would rather you built these without asking each time, they can turn auto-build on for this app.",
            what_the_merchant_does: stepsToFinish(
              reqRow,
              openAt(new URL(req.url).origin, reqRow.project_id, reqRow.id)
            ),
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
      const { data: builtMods } = await db.from("modules").select("*").eq("project_id", reqRow.project_id);
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
      // Named, because the usual cause is signing in as the wrong
      // account: its own email, to its own owner, over their grant.
      return ok(
        id,
        text({
          error: `No Shopify store is connected to ${auth.email ?? "this account"}. If the store is on another Warmluke account, disconnect and connect again signed in as that one.`,
        })
      );
    }
    const wanted = (args.shop_domain as string | undefined)?.trim().toLowerCase();
    // An owner with two projects has two stores, and stores[0] is
    // whichever the database returned first — so a question about one
    // shop could be answered from the other, silently and with a
    // straight face. Ambiguity is now a question rather than a guess.
    // A project named is a store named: one project has one store, so an
    // assistant that says which app it means is not asked which shop.
    const ofProject = typeof args.project_id === "string" ? stores.filter((s) => s.project_id === args.project_id) : [];
    const store = wanted
      ? stores.find((s) => s.shop_domain.toLowerCase() === wanted)
      : ofProject.length === 1
        ? ofProject[0]
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

    // The store's reading tools: one declaration (store-tools), shared
    // with Luke, run against the store settled just above.
    const shared = storeTool(name);
    if (shared) return ok(id, text(await shared.run(args as Record<string, unknown>, { db, store })));

    if (name === "propose_store_action") {
      // One set of gates for every way in (store-action-propose); only
      // where the merchant goes to reconnect is this route's to add.
      const asked = await proposeStoreAction(db, store, args as Record<string, unknown>);
      if (!asked.ok) {
        return ok(
          id,
          text(
            asked.reconnect
              ? { ...asked.answer, open: openAt(new URL(req.url).origin, store.project_id) }
              : asked.answer
          )
        );
      }
      const { id: actionId, action: wantedAction, summary, targets, spec } = asked;

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
          what_the_merchant_does: stepsToFinishAction({ status: "pending", action: wantedAction }, where, spec),
          open: where,
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
