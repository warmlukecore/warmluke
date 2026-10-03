// ─────────────────────────────────────────────────────────────
// One turn of the builder, without deciding where it came from.
//
// Lifted out of the chat route because a second caller arrived: a
// merchant talking to their own Claude, whose request has to be
// designed by the same engine. Copying the loop instead would have
// left two sets of gates, and the copy nobody watches is the one that
// rots — which is exactly how a scan that writes a count it never took
// gets back in.
//
// What stays with the caller: persistence. The chat route keeps a
// thread; the MCP tool keeps a request row. Neither belongs here.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { isStoreTable, storeSectionColumns, storeTableSchema } from "@/lib/store-read";
import {
  asNextSteps,
  buildSystemPrompt,
  buildUserMessage,
  callModel,
  draftMessage,
  draftPhase,
  type DraftPhase,
  findGaps,
  parseReply,
  type ChatTurn,
  type StoreContext,
  buildTalkPrompt,
  stripFences,
  talkModel,
  buildPlanPrompt,
  planModel,
  critique,
  criticModel,
  memoryModel,
} from "@/lib/ai";
import { isQuestion, lastReplyTypeOf, roadFor, type Road } from "@/lib/intent";
import { describeKnown, notesFor } from "@/lib/memory";
import {
  agreedBlock,
  intentBlock,
  isGoAhead,
  parseIntent,
  proposalOf,
  wantsItBuilt,
  type DesignIntent,
} from "@/lib/plan";
import { asJob } from "@/lib/usage";
import { describeMerchant, type ProfileRow } from "@/lib/onboarding";
import {
  describeFeaturesFull,
  describePlan,
  describeRequests,
  describeRules,
  reuseQuestion,
  seededCopies,
  type RequestRow,
  type RuleRow,
  type StoreFacts,
} from "@/lib/describe";
import { describeBuild } from "@/lib/judge";
import { aiStoreTools, fitForModel } from "@/lib/store-tools";
import { aiProposeTool } from "@/lib/store-action-propose";

/**
 * The store tools Luke may look things up with. Not ask_store: it routes
 * a question to rows, and this turn's question was routed before the
 * model was called, into the snapshot's slice.
 */
const LUKE_TOOLS = [
  "store_overview",
  "search_orders",
  "get_order",
  "search_store",
  "low_stock",
  "store_metrics",
] as const;

/**
 * What the plan step may read: enough to settle which rows the work
 * belongs to and what a column really holds. Never a change to the shop.
 */
const PLAN_TOOLS = ["search_store", "store_metrics", "store_overview"] as const;
/** Two lookups, then the plan. */
const PLAN_STEPS = 3;

/**
 * How many rules the designer is shown.
 *
 * ponytail: a flat cap, and the oldest win. An app with more rules
 * than this needs them summarised by section rather than listed;
 * raise it or group them when one actually has that many.
 */
const RULES_IN_CONTEXT = 40;
import { lowStock, searchOrders, storeLeaders, storeOverview, storeValues } from "@/lib/store-read";
import { routeQuestion } from "@/lib/route";
import { fetchSlice } from "@/lib/slice";
import { projectFormat } from "@/lib/money";
import type {
  AssistantPlan,
  AssistantReply,
  FeatureSchema,
  ModuleRow,
  ProjectRow,
  TurnEvent,
  UiSchema,
} from "@/lib/types";
import { tapeRoad } from "@/lib/model-tape";

/**
 * Validation errors are the assistant's own mistakes — a bad column
 * type, a name already taken. Handing them to the owner makes them
 * debug the AI, so they go back to the model instead; only a repeated
 * failure surfaces.
 */
export const MAX_REPAIR_ATTEMPTS = 2;

/** The connected store, as the prompt needs to hear about it. */
export async function storeContextFor(
  client: SupabaseClient,
  projectId: string,
  /**
   * What the merchant just typed. Read by a router while the store is
   * read, so that a question about August or about one customer gets
   * the rows it needs and not only the fixed snapshot. Absent, or not
   * a question the router is sure of, nothing changes.
   */
  question?: string
): Promise<StoreContext | null> {
  // Through the caller's own client, so a project without a store — or
  // a member who cannot see it — simply gets null.
  const { data: storeRow } = await client
    .from("stores")
    .select("id, shop_domain, timezone, currency, country, last_synced_at, history_from, history_days")
    .eq("project_id", projectId)
    .eq("status", "connected")
    .maybeSingle();
  if (!storeRow) return null;

  const overview = await storeOverview(client, storeRow.id as string);

  // Read here, before the model runs, so most questions are answered in
  // one call from rows this code path read. What the snapshot does not
  // hold (one particular order, a day not shown) the chat's turn can
  // look up with the store tools; each lookup is recorded by the tool
  // that ran it, never by the model's word for it (see runTurn).
  const [recent, low, leaders, routed] = await Promise.all([
    searchOrders(client, { id: storeRow.id as string, timezone: storeRow.timezone as string }, { limit: 20 }).catch(
      () => []
    ),
    lowStock(client, storeRow.id as string, { threshold: 10, limit: 15 }).catch(() => []),
    // Whole-store, unlike the two above: the questions these answer are
    // rankings, and a ranking over the latest twenty rows is not one.
    storeLeaders(client, storeRow.id as string).catch(() => ({ top_customers: [], best_sellers: [] })),
    question ? routeQuestion(question) : Promise.resolve(null),
  ]);
  // The rows the question needs, when it read as one. A read that fails
  // is the fixed snapshot alone, which is what every turn had before.
  const slice = routed
    ? await fetchSlice(client, { id: storeRow.id as string, timezone: storeRow.timezone as string }, routed).catch(
        (e: unknown) => {
          console.error(`slice: ${e instanceof Error ? e.message : "failed"}`);
          return null;
        }
      )
    : null;
  const values = await storeValues(client, storeRow.id as string);
  const { data: runs } = await client.from("import_runs").select("status").eq("store_id", storeRow.id);
  const runList = (runs ?? []) as Array<{ status: string }>;

  return {
    store_id: storeRow.id as string,
    shop_domain: storeRow.shop_domain as string,
    timezone: storeRow.timezone as string,
    currency: storeRow.currency as string,
    country: (storeRow.country as string | null) ?? null,
    // Counts quoted mid-import are partial, and a design built on "you
    // have 4 orders" is wrong if 4,000 are still arriving.
    importing: runList.length === 0 || runList.some((r) => r.status !== "done"),
    counts: overview?.counts ?? {},
    values,
    snapshot: {
      last_synced_at: (storeRow.last_synced_at as string | null) ?? null,
      history: storeRow.history_from
        ? { from: storeRow.history_from as string, days: (storeRow.history_days as number | null) ?? null }
        : null,
      top_customers: leaders.top_customers,
      best_sellers: leaders.best_sellers,
      slice: slice
        ? {
            read_as: { list: routed!.list, window: routed!.window, kind: routed!.kind, month: routed!.month },
            ...slice,
          }
        : undefined,
      recent: recent.map((o) => ({
        number: o.order_number ?? "—",
        placed: o.placed_at,
        total: o.total,
        currency: o.currency,
        status: o.financial_status,
      })),
      low: low.map((l) => ({
        product: l.product ?? "—",
        variant: l.variant,
        location: l.location,
        available: l.available,
      })),
    },
  };
}

export type TurnInput = {
  client: SupabaseClient;
  project: ProjectRow;
  modules: ModuleRow[];
  /** What the owner actually asked for. */
  message: string;
  /** Earlier turns of the same conversation, oldest first. */
  history?: ChatTurn[];
  currentSchema?: UiSchema | null;
  currentFeatures?: FeatureSchema | null;
  /**
   * Whether a design has already been shown in this thread. Sections
   * may only be created after one — otherwise the assistant skips
   * straight to building things nobody agreed to.
   */
  blueprintShown?: boolean;
  /**
   * Whether plain plans are an acceptable answer. In the chat they are
   * not until a design has been shown, or the assistant builds things
   * nobody agreed to. Through the MCP tool they always are: that tool
   * cannot build anything, so the design it returns IS the showing.
   * Defaults to blueprintShown.
   */
  plansAllowed?: boolean;
  /** Module context for the turn, when the owner is looking at one. */
  moduleId?: string | null;
  /**
   * Whether the model may look more up with the store tools before it
   * replies. The chat says yes. The MCP design engine does not: the
   * client asking has the same tools of its own, and a design turn
   * spent on lookups is our model budget spent twice.
   */
  lookups?: boolean;
  signal?: AbortSignal;
  /**
   * Told each step as it happens, so a caller that can stream has
   * something true to show while the model thinks. Absent, nothing is
   * said — the MCP tool answers in one piece and never asks.
   */
  onEvent?: (event: TurnEvent) => void;
  /**
   * Hears what Luke is saying as it is written: the reply's message, so
   * far, whole each time, and "" when an attempt starts over. A draft
   * for the screen, never the reply: the one the validator passes
   * replaces it. Absent, the model is not streamed at all.
   */
  onWords?: (text: string, phase?: DraftPhase) => void;
  /**
   * The model the reply is made on, already checked against what the
   * account may use (luke-models.ts). Absent, the server's design model.
   */
  model?: string;
  /**
   * When this invocation must hand the turn on (epoch ms). Past it, with
   * too little left for another attempt, the turn pauses between
   * attempts and returns its state. Absent, it runs to the end.
   */
  deadline?: number;
  /** A paused turn's state, to go on from where it stopped. */
  resume?: TurnState;
};

/**
 * A turn stopped between attempts, to go on in another invocation: all
 * it had, as plain data. A durable turn (workflows/luke-turn.ts) runs
 * in legs, each short of a function's time, and hands this from one to
 * the next; a leg that dies starts again from the last one handed on.
 */
export type TurnState = {
  store: StoreContext | null;
  road: Road;
  planned: boolean;
  planBlock: string;
  /** The owner agreed to this design in words before it was drawn. */
  approved?: boolean;
  attemptTurns: ChatTurn[];
  attempt: number;
  raw: string;
  parsed: ReturnType<typeof parseReply> | null;
  repairs: number;
  repairErrors: string[];
  reuse: ReturnType<typeof reuseQuestion>;
  onlyAsking: boolean;
  critiqued: { unmet: string[] } | null;
  sentBack: boolean;
  sentBackDesign: { parsed: ReturnType<typeof parseReply>; raw: string; unmet: string[] } | null;
  lookedUp: string[];
  /** What the lookups returned, cut to size: a repair reads it again. Absent in a state from before it was kept. */
  found?: Array<{ about: string; result: unknown }>;
};

/** How much of what the lookups returned rides along with a repair. */
const FOUND_CHARS = 12_000;

/**
 * What the lookups returned, for a repair to read again: the rows as the
 * tools gave them, every field they carried. Nothing when nothing was
 * looked up, so a turn without lookups repairs exactly as before.
 */
export function foundBlock(found: Array<{ about: string; result: unknown }>): string {
  if (found.length === 0) return "";
  let out =
    "\n\nWhat your lookups returned before, unchanged (every field the rows carry, not only what a section shows):";
  for (const f of found) {
    const line = `\n- ${f.about}: ${JSON.stringify(f.result)}`;
    if (out.length + line.length > FOUND_CHARS) {
      out += "\n- (the rest was cut to fit)";
      break;
    }
    out += line;
  }
  return out;
}

/** What one design attempt, and the critic after it, can take: the time a leg keeps in hand before starting one. */
export const ATTEMPT_MS = 120_000;

export type TurnResult =
  | {
      ok: true;
      reply: AssistantReply;
      /** Exactly what the model returned, for replay and for history. */
      raw: string;
      /** The CONTEXT-wrapped turn that was sent, which history replays. */
      userTurn: string;
      repairs: number;
      repairErrors: string[];
      store: StoreContext | null;
      /** What they asked for that this does not do. Possibly empty. */
      unmet: string[];
      /** What the model looked up with the store tools, in words, as the tools recorded it. */
      lookedUp: string[];
      /** Which road the turn took: only how to answer, or the whole design contract. */
      road: Road;
      /** What was known about the business when this turn was made, newest first. */
      known: string[];
    }
  | {
      ok: false;
      errors: string[];
      repairs: number;
      repairErrors: string[];
      /** Only with a deadline: out of time between attempts, the turn so far to go on from. */
      paused?: TurnState;
    };

/**
 * Runs the model, repairs what the validator rejects, and fills in the
 * gaps a blueprint failed to mention. Writes nothing.
 */
/** What a design builds, by name, for the steps the owner watches: "Add fields to Orders", "Rule: Ship by". */
const partsOf = (plans: AssistantPlan[], modules: ModuleRow[]): string[] =>
  plans.slice(0, 6).map((p) => describePlan(p, modules).title);

/**
 * The current schema of every section in a project, by module id.
 *
 * A design may touch any section, and only one of them can be the
 * "current" one — through the MCP tool, none of them is. Without this
 * the validator had nothing to check field references against, and
 * read that as "cannot check", which it treated as "passes". So a rule
 * could name a column that does not exist and be accepted.
 *
 * It is also what the model is shown: it used to be handed the columns
 * of the open section and nothing else, so asked through MCP to put a
 * rule on a section by name it could only answer that it could not see
 * the fields.
 *
 * Store-backed sections answer with the store's columns rather than
 * whatever is saved against them, because that is what is rendered,
 * plus any computed columns, which are not the store's and are kept.
 */
export async function schemasFor(client: SupabaseClient, modules: ModuleRow[]): Promise<Map<string, UiSchema>> {
  const byModule = new Map<string, UiSchema>();
  if (modules.length === 0) return byModule;

  const { data } = await client
    .from("ui_schemas")
    .select("module_id, schema_json, version")
    .in(
      "module_id",
      modules.map((m) => m.id)
    )
    .order("version", { ascending: false });

  // Ordered newest first, so the first row seen for a module is its
  // current version and every later one is history.
  for (const row of (data ?? []) as Array<{ module_id: string; schema_json: UiSchema }>) {
    if (!byModule.has(row.module_id)) byModule.set(row.module_id, row.schema_json);
  }
  for (const m of modules) {
    if (m.source_table && isStoreTable(m.source_table)) {
      const saved = byModule.get(m.id);
      byModule.set(m.id, {
        columns: storeSectionColumns(m.source_table, saved?.columns),
        features: saved?.features ?? null,
      });
    }
  }
  return byModule;
}

/**
 * The connected store as the overlap and seed checks need it: which
 * shop, its currency, and how many of each list it holds. A fraction
 * of storeContextFor, for a caller that has plans to check and no
 * design to write.
 */
export async function storeFactsFor(client: SupabaseClient, projectId: string): Promise<StoreFacts | null> {
  const { data: row } = await client
    .from("stores")
    .select("id, shop_domain, currency")
    .eq("project_id", projectId)
    .eq("status", "connected")
    .maybeSingle();
  if (!row) return null;
  const overview = await storeOverview(client, row.id as string).catch(() => null);
  return { shop_domain: row.shop_domain as string, currency: row.currency as string, counts: overview?.counts ?? {} };
}

/** How far back, and how many, of a connected assistant's requests Luke is told about. */
const REQUESTS_DAYS = 14;
const REQUESTS_IN_CONTEXT = 5;

/**
 * What the owner's own connected assistant asked this app for lately,
 * newest first, as lines for the prompt.
 *
 * Luke reads the app's structure fresh every turn, so a section their
 * Claude built is visible to it — but not why it was built, or that it
 * was their Claude that asked. "Change what my AI just added" landed
 * in a thread that had never heard of it. The request rows hold that
 * intent: what was asked, whether it was built, what failed. Read
 * through the caller's own client, so RLS decides what they may see;
 * a project with none, or a read that fails, is simply no block.
 */
export async function recentRequests(
  client: SupabaseClient,
  projectId: string,
  modules: ModuleRow[],
  now = new Date()
): Promise<string[]> {
  try {
    const since = new Date(now.getTime() - REQUESTS_DAYS * 86400000).toISOString();
    const { data, error } = await client
      .from("build_requests")
      .select("id, request, status, summary, plans, outcome, client_id, created_at, built_at")
      .eq("project_id", projectId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(REQUESTS_IN_CONTEXT);
    if (error) throw new Error(error.message);
    return describeRequests((data ?? []) as RequestRow[], modules, now);
  } catch (e) {
    console.error(`requests: ${e instanceof Error ? e.message : "failed"}`);
    return [];
  }
}

/** Each section's columns in one line, for the model to read. */
/**
 * Every section as the model is told it: what rows it shows, its fields,
 * and what it already does. Without the last two a later request that
 * belonged in "Packing" (a scan bar on the orders) read as new work, and
 * was built as a second section beside it. Written from what is saved,
 * so it is always what is there.
 */
function columnLines(modules: ModuleRow[], schemas: Map<string, UiSchema>): string[] {
  return modules.map((m) => {
    const schema = schemas.get(m.id);
    const cols = schema?.columns ?? [];
    const store = isStoreTable(m.source_table)
      ? new Set(storeTableSchema(m.source_table).columns.map((c) => c.field))
      : null;
    const spelled = cols.length
      ? cols
          .map(
            (c) => `${c.field} (${c.type}${c.compute ? ", computed" : store && !store.has(c.field) ? ", theirs" : ""})`
          )
          .join(", ")
      : "no fields yet";
    const over = store ? ` — over the store's ${m.source_table}` : "";
    const does = schema?.features ? describeFeaturesFull(schema.features, modules) : [];
    return `- ${m.nav_label} [id ${m.id}]${over}: ${spelled}${does.length ? `. Does: ${does.join("; ")}` : ""}`;
  });
}

/** What stands in a thread where an answer never came: still coming, stopped, or failed. */
const UNANSWERED = new Set(["answering", "unanswered", "stopped"]);

/** Said to the model where an answer never came, so "try again" has something to point at. */
export const NOT_ANSWERED =
  "(Not answered: this turn failed or was stopped, and nothing was changed. If what they say next points back to it, in whatever words or language, this is what they mean.)";

/**
 * A thread's rows as the model is told them. A question whose answer
 * never came is kept while it is the latest thing asked: after it, the
 * owner's "try again" means it, and with it left out Luke guessed and
 * asked about something from the day before. Its stand-in line is kept
 * for the caller to say as NOT_ANSWERED. Once an answer has come after
 * it, it is history and left out, and one still being answered
 * elsewhere is not this turn's to read.
 */
export function answeredTurns<T extends { role: string; ptype: string | null }>(rows: T[]): T[] {
  const lastAnswer = rows.findLastIndex((m) => m.role === "assistant" && !UNANSWERED.has(m.ptype ?? ""));
  return rows.filter((m, i) => {
    const pair = UNANSWERED.has(m.ptype ?? "")
      ? m.ptype
      : m.role === "user" && UNANSWERED.has(rows[i + 1]?.ptype ?? "")
        ? rows[i + 1].ptype
        : null;
    return pair === null || (pair !== "answering" && i > lastAnswer);
  });
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const {
    client,
    project,
    modules,
    message,
    history = [],
    currentSchema = null,
    currentFeatures = null,
    blueprintShown = false,
    plansAllowed = blueprintShown,
    moduleId = null,
    lookups = false,
    signal,
    onEvent,
    onWords,
    model,
    deadline,
    resume,
  } = input;
  // Said after the fact, with what was found. A listener that throws
  // must not take the turn down with it: the work is the point, the
  // narration is not.
  const tell = (event: TurnEvent) => {
    try {
      onEvent?.(event);
    } catch {
      /* the caller's problem, not the turn's */
    }
  };

  // Read on the first leg only: every leg after designs on the same store it planned on.
  const store = resume ? resume.store : await storeContextFor(client, project.id, message);
  if (!resume) tell({ step: "store", shop: store?.shop_domain ?? null, read: store?.snapshot?.slice?.what ?? null });
  // What already runs on this app. Left out, the designer proposes a
  // rule that exists, or tells the merchant no rule exists when one
  // fires every morning. It goes in the user turn rather than the
  // system prompt because that prompt is cached across projects.
  // Beside it, what the owner's own connected assistant asked for
  // lately: the one piece of intent that lives outside this thread.
  const [{ data: ruleRows }, requests, { data: changeOn }, { data: profile }, notesRows] = await Promise.all([
    client
      .from("automations")
      .select("id, name, enabled, module_id, definition")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true })
      .limit(RULES_IN_CONTEXT),
    recentRequests(client, project.id, modules),
    // Whether Luke may ask for a change in the shop: the account's own
    // switch, off unless somebody at Warmluke turned it on. Read only
    // when the tools are on offer at all.
    lookups && store ? client.rpc("abo_feature", { p_name: "store_actions" }) : Promise.resolve({ data: false }),
    // Who they are, from onboarding: read under their own RLS, so a
    // connected assistant acting for them reads theirs and nobody else's.
    client.from("profiles").select("full_name, business_name, role, monthly_orders, platform, team_size").maybeSingle(),
    // What earlier conversations taught about the business (0131), read
    // only when something writes it: the setting is the switch.
    memoryModel() ? notesFor(client, project.id) : Promise.resolve([] as string[]),
  ]);
  const known = notesRows;
  const merchant =
    [describeMerchant(profile as ProfileRow | null), describeKnown(known)].filter(Boolean).join("\n") || null;
  const rules = describeRules((ruleRows ?? []) as RuleRow[], modules);

  // Every section's columns, so a design that touches one the caller
  // did not have open is both checked and readable.
  const schemas = await schemasFor(client, modules);
  if (!resume) tell({ step: "context", sections: modules.length, rules: (ruleRows ?? []).length });

  // The store tools, when this caller allows them and there is a store
  // to read. Each lookup is told as it comes back and kept once for the
  // receipt: a transient retry that runs the same lookup again is still
  // one thing looked up.
  const lookedUp: string[] = [...(resume?.lookedUp ?? [])];
  // And what each one returned, cut to size. A repair has no tools, and
  // used to have only its own rejected reply to go on: a design refused
  // for naming a field could not look at the rows again to find the
  // field it should have named.
  const found: Array<{ about: string; result: unknown }> = [...(resume?.found ?? [])];
  const heard = new Set<string>();
  const hear = ({ about, tool, args, result }: { tool: string; about: string; args: unknown; result?: unknown }) => {
    const key = `${tool}:${JSON.stringify(args)}`;
    if (heard.has(key)) return;
    heard.add(key);
    lookedUp.push(about);
    found.push({ about, result: fitForModel(result, 4_000) });
    tell({ step: "lookup", about });
  };
  const toolStore =
    lookups && store?.store_id
      ? {
          db: client,
          store: {
            id: store.store_id,
            project_id: project.id,
            shop_domain: store.shop_domain,
            timezone: store.timezone,
            currency: store.currency,
            last_synced_at: store.snapshot?.last_synced_at ?? null,
          },
        }
      : null;
  const canChange = !!toolStore && changeOn === true;
  const tools = toolStore
    ? {
        ...aiStoreTools(toolStore, { only: LUKE_TOOLS, observe: hear }),
        // Asking for a change in the shop, when the account allows it.
        // It only ever makes a request the merchant agrees to or not.
        ...(canChange
          ? { propose_store_action: aiProposeTool(toolStore, ({ summary }) => tell({ step: "proposed", summary })) }
          : {}),
      }
    : null;
  // The draft, told only when it changes: a stream of the same words
  // over and over would be a stream of nothing.
  // What is being written once the words are done ("questions"), told
  // the same way: the words stop, and the rest is still coming.
  let drafted = "";
  let phased: DraftPhase | null = null;
  const draft = onWords
    ? (text: string) => {
        const said = text === "" ? "" : draftMessage(text);
        const phase = text === "" ? null : draftPhase(text);
        if (said === null || (said === drafted && phase === phased)) return;
        drafted = said;
        phased = phase;
        try {
          onWords(said, phase ?? undefined);
        } catch {
          /* the caller's problem, not the turn's */
        }
      }
    : undefined;

  // Before the prompt is written: it offers only what the tools can do.
  if (store) {
    store.canLookUp = !!tools;
    store.canChange = canChange;
  }

  // Which road: only how to answer, or the whole design contract. The
  // talk road hands a build back (below), so a wrong turn onto it costs
  // one small call; a wrong turn onto the design road costs tokens.
  // Talk first, in the app's own chat (Tanish, 3 Oct): a design is said
  // in words before it is drawn, and built on a yes. The plan Luke said
  // last, and whether this is the plain yes to it: decided here, from the
  // thread as kept, never by a model.
  const agreed = lookups && !resume ? proposalOf(history) : null;
  const goAhead = !!agreed && isGoAhead(message);
  const approved = resume?.approved ?? (goAhead || (!!lookups && wantsItBuilt(message)));
  let road: Road =
    resume?.road ??
    // After a plan in words, an answer to its questions is more of the
    // design, not a follow-up question: it plans again.
    (agreed && (goAhead || !isQuestion(message))
      ? "design"
      : roadFor({ message, lastReplyType: lastReplyTypeOf(history), routed: !!store?.snapshot?.slice }));
  if (!resume) tell({ step: "road", road });
  // Money as the owner chose it, else as their shop keeps it: Luke writes the same currency the app shows.
  const money = projectFormat(project, store);
  const designSystem = () => buildSystemPrompt(modules, project.name, money.locale, money.currency, store, merchant);
  let system =
    road === "talk"
      ? buildTalkPrompt(modules, project.name, money.locale, money.currency, store, merchant)
      : designSystem();
  const userTurn = buildUserMessage(
    message,
    moduleId,
    currentSchema ?? (moduleId ? (schemas.get(moduleId) ?? null) : null),
    currentFeatures,
    rules,
    columnLines(modules, schemas),
    requests
  );

  // What Luke understood, before it designs: a short call with none of
  // the design grammar in front of it, whose words are read by the
  // design call. Once a turn; not when the owner is answering a design
  // already drawn (a yes, a no, a tweak). A plan that fails to come or
  // to parse is no plan, and the design goes on as it always did.
  let planBlock = resume?.planBlock ?? "";
  let planned = resume?.planned ?? false;
  // Held in a box: the plan step sets it from inside its closure.
  const understood: { intent: DesignIntent | null } = { intent: null };
  // The setting is the switch: no plan model, no plan step — and no critic.
  const planOn = planModel();
  const plan = async () => {
    if (planned) return;
    planned = true;
    if (!planOn || lastReplyTypeOf(history) === "blueprint") return;
    // Said at once, before the model is asked: the plan is the longest
    // silence of a turn, and a step told only at its end reads as none.
    tell({ step: "plan", goal: null });
    let goal: string | null = null;
    try {
      // The store's reading tools, bounded, and heard the same way: a
      // lookup made while planning is a lookup the owner sees and the
      // receipt keeps.
      const planTools = toolStore ? aiStoreTools(toolStore, { only: PLAN_TOOLS, observe: hear }) : null;
      const raw = await asJob("plan", () =>
        callModel({
          system: buildPlanPrompt(modules, project.name, money.locale, money.currency, store, merchant),
          turns: [...history, { role: "user", content: userTurn }],
          signal,
          model: model ?? planOn,
          lookups: planTools ? { tools: planTools, steps: PLAN_STEPS } : undefined,
        })
      );
      const intent = parseIntent(raw);
      if (intent) {
        planBlock = intentBlock(intent);
        goal = intent.goal;
        understood.intent = intent;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      console.error(`[plan] ${e instanceof Error ? e.message : "failed"}`);
    }
    if (goal) tell({ step: "plan", goal });
  };
  // Their yes: what they agreed to is the plan, built as said.
  if (goAhead && agreed) {
    planned = true;
    planBlock = agreedBlock(agreed);
    tell({ step: "plan", goal: agreed.goal });
  }
  if (road === "design") await plan();

  // The plan, said in words, and nothing drawn or built until they say
  // yes. Not for a design already on screen (a tweak to it), not when
  // they asked to just build it, and not through an outside assistant,
  // which has its own approval. One small call: the design waits.
  const said = understood.intent;
  if (lookups && !resume && road === "design" && !approved && said?.say && lastReplyTypeOf(history) !== "blueprint") {
    const reply = {
      type: "answer" as const,
      kind: "proposal" as const,
      title: said.goal.slice(0, 80),
      message: said.say,
      next: [{ label: "Build it", prompt: "Build it" }],
      understood: said,
    };
    return {
      ok: true,
      reply,
      raw: JSON.stringify(reply),
      userTurn,
      repairs: 0,
      repairErrors: [],
      store,
      unmet: [],
      lookedUp,
      road,
      known,
    };
  }

  // The rejected attempt and its errors stay in the turns sent to the
  // model but are never persisted — replaying a malformed reply from
  // history would only teach it to repeat the mistake. The plan's words
  // ride with the request here and are not persisted either: the
  // thread keeps what the owner said, not what Luke made of it.
  const attemptTurns: ChatTurn[] = resume?.attemptTurns ?? [{ role: "user", content: userTurn + planBlock }];
  let raw = resume?.raw ?? "";
  let parsed: ReturnType<typeof parseReply> | null = resume?.parsed ?? null;
  let repairs = resume?.repairs ?? 0;
  // The question the code would ask about where this work goes, once the
  // model has been told to ask it: its words are the fallback.
  let reuse: ReturnType<typeof reuseQuestion> = resume?.reuse ?? null;
  let onlyAsking = resume?.onlyAsking ?? false;
  // Which gate fired, not just how often something did. The count
  // alone cannot tell a malformed shape from a design that missed the
  // point, and those want opposite remedies.
  const repairErrors: string[] = [...(resume?.repairErrors ?? [])];
  // The critic's word on a design that passed every gate: what it still
  // misses, in the owner's words, and — once a turn — that it goes back.
  let critiqued: { unmet: string[] } | null = resume?.critiqued ?? null;
  let sentBack = resume?.sentBack ?? false;
  // The design the critic sent back, which stood: kept, so a redo that
  // fails does not cost the design it was redoing.
  let sentBackDesign: { parsed: ReturnType<typeof parseReply>; raw: string; unmet: string[] } | null =
    resume?.sentBackDesign ?? null;

  const firstAttempt = resume?.attempt ?? 0;
  for (let attempt = firstAttempt; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    // Out of this invocation's time, with an attempt made in it: the
    // turn so far, handed on whole, to go on in a fresh one.
    if (deadline && attempt > firstAttempt && Date.now() + ATTEMPT_MS > deadline) {
      return {
        ok: false,
        errors: [],
        repairs,
        repairErrors,
        paused: {
          store,
          road,
          planned,
          planBlock,
          approved,
          attemptTurns,
          attempt,
          raw,
          parsed,
          repairs,
          repairErrors,
          reuse,
          onlyAsking,
          critiqued,
          sentBack,
          sentBackDesign,
          lookedUp,
          found,
        },
      };
    }
    tell({ step: "model", attempt: attempt + 1, of: MAX_REPAIR_ATTEMPTS + 1 });
    // Tools on the first attempt only: a repair fixes the reply's shape,
    // and what was looked up is already written into the reply it fixes.
    raw = await tapeRoad.run(road, () =>
      callModel({
        system,
        turns: [...history, ...attemptTurns],
        signal,
        // The one they picked wins on both roads; otherwise each road's own.
        model: model ?? (road === "talk" ? talkModel() : undefined),
        lookups: attempt === 0 && tools ? { tools } : undefined,
        onText: draft,
      })
    );
    // The talk road hands a build back: a "build" reply, or a design it
    // drew anyway. The design road then starts over, tools and all.
    if (road === "talk") {
      let said: unknown = null;
      try {
        said = JSON.parse(stripFences(raw));
      } catch {
        /* the parser below says so */
      }
      const type = said && typeof said === "object" ? (said as { type?: unknown }).type : undefined;
      if (typeof type === "string" && type !== "answer") {
        road = "design";
        tell({ step: "road", road });
        system = designSystem();
        await plan();
        attemptTurns.splice(0, attemptTurns.length, { role: "user", content: userTurn + planBlock });
        draft?.("");
        attempt = -1;
        continue;
      }
    }
    parsed = parseReply(
      raw,
      modules,
      currentSchema,
      currentFeatures,
      (mid) => schemas.get(mid) ?? null,
      (mid) => ((ruleRows ?? []) as RuleRow[]).filter((r) => r.module_id === mid)
    );
    // A question answered in prose instead of JSON: the prose is the
    // answer. Sending the whole turn back for its braces paid for it
    // twice (2 Oct: a 15-day summary, $0.19 of its $0.25 on the resend).
    const prose = stripFences(raw).trim();
    if (!parsed.ok && prose && !/^[[{]/.test(prose) && isQuestion(message)) {
      parsed = parseReply(
        JSON.stringify({ type: "answer", message: prose }),
        modules,
        currentSchema,
        currentFeatures,
        (mid) => schemas.get(mid) ?? null
      );
    }

    // Structural gate, enforced here rather than trusted to the prompt.
    if (
      parsed.ok &&
      parsed.reply.type === "plans" &&
      !plansAllowed &&
      parsed.reply.plans.some((pl) => pl.changeType === "NEW_MODULE")
    ) {
      parsed = {
        ok: false,
        errors: [
          'You tried to create new sections before showing the owner a design. Reply with a "blueprint" instead so they can approve it first.',
        ],
      };
    }

    // Made-up rows beside the store's own: the one thing a hand-kept
    // copy of a store list may not carry. Sent back like any other
    // validation error, with the list to build over instead.
    if (parsed.ok && parsed.reply.type !== "clarify" && parsed.reply.type !== "answer") {
      const plans = parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans;
      const facts = store ? { shop_domain: store.shop_domain, currency: store.currency, counts: store.counts } : null;
      const copies = seededCopies(plans, facts);
      if (copies.length) parsed = { ok: false, errors: copies };
      // A design that works on rows a section of theirs, or a store list,
      // already holds: where it goes is the owner's to say, in one tap,
      // before anything is drawn. Asked once a thread, and never right
      // after they answered a question, so an answer stands.
      if (!copies.length && parsed.ok && parsed.reply.type === "blueprint") {
        if (reuse) {
          // Told to ask, and it designed anyway: asked in the code's own
          // words, and kept as what was said — the thread's history is
          // what the owner saw, not a design nobody was shown.
          parsed = { ok: true, reply: reuse };
          raw = JSON.stringify(reuse);
        } else {
          const saidSoFar = history.filter((t) => t.role === "assistant").map((t) => t.content);
          const justAnswered = saidSoFar.at(-1)?.includes('"clarify"') ?? false;
          const asked = (key: string) =>
            justAnswered || saidSoFar.some((c) => c.includes('"clarify"') && c.includes(key));
          const question = reuseQuestion(plans, modules, (id) => schemas.get(id)?.columns, facts, asked);
          if (question) {
            // Sent back to be asked by the model, in the owner's own
            // language: the code knows what overlaps, the model how they
            // speak.
            reuse = question;
            onlyAsking = true;
            const q = question.questions[0];
            parsed = {
              ok: false,
              errors: [
                `Do not design this yet. ${q.question} Ask the owner exactly that, in their own language: reply with "clarify" holding ONE question, id "${q.id}", whose two suggestions mean "${q.suggestions?.[0]}" and "${q.suggestions?.[1]}", each saying what they get for THIS work; "recommended" the one you would pick for them, and "why" your reason in a line.`,
              ],
            };
          }
        }
      }
    }

    // What the validator actually said — zero problems, or this many on
    // their way back to the model. Not "checked" because time passed.
    // Named when it passed, so the owner watches their own build being
    // checked, not a line that reads the same for every ask.
    tell({
      step: "checked",
      problems: parsed.ok || onlyAsking ? 0 : parsed.errors.length,
      ...(parsed.ok && (parsed.reply.type === "plans" || parsed.reply.type === "blueprint")
        ? {
            parts: partsOf(
              parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans,
              modules
            ),
          }
        : {}),
    });

    // The gates cover the grammar; the critic covers the point. With the
    // plan switch on it reads the ask, what was understood and what will
    // be built, and may send the design back once, in the same loop the
    // repairs use. A critic that fails to answer is no critic.
    if (parsed.ok && planOn && parsed.reply.type !== "clarify" && parsed.reply.type !== "answer") {
      const plans = parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans;
      const verdict = await critique({
        ownerWords: message.trim(),
        understood: planBlock,
        builtDescription: describeBuild(plans, modules, currentSchema?.columns, store, { screens: true }),
        model: model ?? criticModel() ?? planOn,
        signal,
      });
      if (verdict) {
        critiqued = { unmet: verdict.unmet };
        if (verdict.redo && !sentBack && attempt < MAX_REPAIR_ATTEMPTS) {
          sentBack = true;
          sentBackDesign = { parsed, raw, unmet: verdict.unmet };
          tell({ step: "critic", verdict: "redo", missing: verdict.unmet.length });
          attemptTurns.push(
            { role: "assistant", content: raw },
            {
              role: "user",
              content: `The design was checked against what the owner asked for and sent back: ${verdict.redo}\n\nStill missing, in their words:\n${verdict.unmet
                .map((u) => `- ${u}`)
                .join(
                  "\n"
                )}\n\nRedesign so it does this too, and reply with the corrected JSON only. Do not apologise or explain.`,
            }
          );
          continue;
        }
        tell({ step: "critic", verdict: "fits", missing: verdict.unmet.length });
      }
    }
    if (parsed.ok) break;

    repairs = attempt + 1;
    // A question to ask is not a problem the design had.
    if (!onlyAsking) {
      repairErrors.push(...parsed.errors);
      // To the log as well as the receipt: what the grammar refuses
      // most is what the prompt, or the grammar, should say better.
      console.warn(`[validator] attempt ${attempt + 1} rejected: ${parsed.errors.join(" | ")}`);
    }
    onlyAsking = false;
    if (attempt === MAX_REPAIR_ATTEMPTS) break;
    attemptTurns.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Your previous reply was rejected by the validator:\n${parsed.errors
          .map((e) => `- ${e}`)
          .join(
            "\n"
          )}\n\nFix every one of these and reply again with the corrected JSON only. Do not apologise or explain — just the corrected reply. If a module name is already taken, either target the existing module instead of creating a new one, or choose a different name.${foundBlock(found)}`,
      }
    );
  }

  // Sent back by the critic, and the redo never stood: the design it
  // sent back is the answer, with what the critic found missing said
  // plainly as unmet. It once was thrown away, and a turn that had a
  // good design told the owner "Luke could not get this right".
  if ((!parsed || !parsed.ok) && sentBackDesign) {
    parsed = sentBackDesign.parsed;
    raw = sentBackDesign.raw;
    critiqued = { unmet: sentBackDesign.unmet };
  }

  // Told to ask and out of attempts: the question is still asked.
  if ((!parsed || !parsed.ok) && reuse) {
    parsed = { ok: true, reply: reuse };
    raw = JSON.stringify(reuse);
  }
  if (!parsed || !parsed.ok) {
    return {
      ok: false,
      errors: parsed?.errors ?? ["Luke could not produce a valid reply."],
      repairs,
      repairErrors,
    };
  }

  // Gates cover the grammar; this covers the judgment — whether the
  // design actually does what was asked. It used to run on blueprints
  // only, which left every plain-plans answer saying nothing about
  // the half of the request it quietly dropped.
  let unmet: string[] = [];
  // Neither a clarify nor an answer has a design in it. The gap pass
  // asks "does what you built do what they asked" — of a question
  // answered, there is nothing to ask that of, and running it would
  // spend a second model call to compare prose with nothing.
  if (parsed.reply.type !== "clarify" && parsed.reply.type !== "answer") {
    const plans = parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans;
    let gaps: string[];
    if (critiqued) {
      // The critic already read this design against the ask.
      gaps = critiqued.unmet;
    } else {
      const built = describeBuild(plans, modules, currentSchema?.columns, store, { screens: true });
      tell({ step: "gaps", parts: partsOf(plans, modules) });
      gaps = await findGaps(message.trim(), built, signal);
    }
    const existing = parsed.reply.type === "blueprint" ? (parsed.reply.blueprint.unmet ?? []) : [];
    const seen = new Set(existing.map((u) => u.toLowerCase().trim()));
    unmet = [...existing, ...gaps.filter((g) => !seen.has(g.toLowerCase().trim()))].slice(0, 6);
    // The gap pass may have added to what this design cannot do; a
    // follow-up that offers one of those is dropped here, the same
    // way the parser dropped the ones the model listed itself.
    if (parsed.reply.type === "blueprint") {
      parsed.reply.blueprint.unmet = unmet;
      parsed.reply.blueprint.next = asNextSteps(parsed.reply.blueprint.next, unmet);
    } else {
      parsed.reply.next = asNextSteps(parsed.reply.next, unmet);
    }
  }

  // Agreed in words first: the chat builds it without asking again.
  if (approved && (parsed.reply.type === "plans" || parsed.reply.type === "blueprint")) parsed.reply.approved = true;

  return { ok: true, reply: parsed.reply, raw, userTurn, repairs, repairErrors, store, unmet, lookedUp, road, known };
}

/**
 * A blueprint as words, generated from the plans rather than from the
 * sentence the model wrote beside them.
 *
 * The same description the approval card shows. An assistant relaying
 * this in its own words could promise something the plans do not do;
 * this is what the merchant is actually agreeing to.
 */
export function blueprintAsText(
  reply: AssistantReply,
  modules: ModuleRow[],
  store: StoreContext | null,
  /** Gaps found for this turn; a plains-plans reply has nowhere else to carry them. */
  unmet: string[] = []
): string | null {
  if (reply.type === "clarify") return null;
  // A reply of plain plans is an edit to something that already
  // exists. It still gets described the same way — the merchant is
  // approving it either way, so they read the same sentences.
  // A question answered has no design to render — it is already prose.
  if (reply.type === "answer") return reply.message;

  const bp = reply.type === "blueprint" ? reply.blueprint : { summary: reply.message, plans: reply.plans, unmet };
  const facts = store ? { shop_domain: store.shop_domain, currency: store.currency, counts: store.counts } : null;

  const lines: string[] = [bp.summary ?? "Here is what would be built."];
  for (const plan of bp.plans) {
    const d = describePlan(plan, modules, undefined, facts);
    lines.push("", d.title);
    for (const l of d.lines) lines.push(`  · ${l}`);
    for (const w of d.warnings ?? []) lines.push(`  ! ${w}`);
    if (plan.optional) {
      lines.push(`  (optional${plan.optionalWhy ? ` — ${plan.optionalWhy}` : ""})`);
    }
  }
  if (bp.unmet?.length) {
    lines.push("", "Not covered by this:");
    for (const u of bp.unmet) lines.push(`  · ${u}`);
  }
  return lines.join("\n");
}
