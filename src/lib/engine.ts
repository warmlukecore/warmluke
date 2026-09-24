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
import { isStoreTable, storeTableSchema } from "@/lib/store-read";
import {
  asNextSteps,
  buildSystemPrompt,
  buildUserMessage,
  callModel,
  draftMessage,
  findGaps,
  parseReply,
  type ChatTurn,
  type StoreContext,
} from "@/lib/ai";
import {
  describePlan,
  describeRequests,
  describeRules,
  seededCopies,
  type RequestRow,
  type RuleRow,
  type StoreFacts,
} from "@/lib/describe";
import { describeBuild } from "@/lib/judge";
import { aiStoreTools } from "@/lib/store-tools";
import { aiProposeTool } from "@/lib/store-action-propose";

/**
 * The store tools Luke may look things up with. Not ask_store: it routes
 * a question to rows, and this turn's question was routed before the
 * model was called, into the snapshot's slice.
 */
const LUKE_TOOLS = ["store_overview", "search_orders", "get_order", "search_store", "low_stock"] as const;

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
import type { AssistantReply, FeatureSchema, ModuleRow, ProjectRow, TurnEvent, UiSchema } from "@/lib/types";

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
    .select("id, shop_domain, timezone, currency, last_synced_at")
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
    searchOrders(
      client,
      { id: storeRow.id as string, timezone: storeRow.timezone as string },
      { limit: 20 }
    ).catch(() => []),
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
  const { data: runs } = await client
    .from("import_runs")
    .select("status")
    .eq("store_id", storeRow.id);
  const runList = (runs ?? []) as Array<{ status: string }>;

  return {
    store_id: storeRow.id as string,
    shop_domain: storeRow.shop_domain as string,
    timezone: storeRow.timezone as string,
    currency: storeRow.currency as string,
    // Counts quoted mid-import are partial, and a design built on "you
    // have 4 orders" is wrong if 4,000 are still arriving.
    importing: runList.length === 0 || runList.some((r) => r.status !== "done"),
    counts: overview?.counts ?? {},
    values,
    snapshot: {
      last_synced_at: (storeRow.last_synced_at as string | null) ?? null,
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
  onWords?: (text: string) => void;
};

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
    }
  | { ok: false; errors: string[]; repairs: number; repairErrors: string[] };

/**
 * Runs the model, repairs what the validator rejects, and fills in the
 * gaps a blueprint failed to mention. Writes nothing.
 */
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
export async function schemasFor(
  client: SupabaseClient,
  modules: ModuleRow[]
): Promise<Map<string, UiSchema>> {
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
        columns: [
          ...storeTableSchema(m.source_table).columns,
          ...(saved?.columns ?? []).filter((c) => c.compute),
        ],
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
function columnLines(modules: ModuleRow[], schemas: Map<string, UiSchema>): string[] {
  return modules.map((m) => {
    const cols = schemas.get(m.id)?.columns ?? [];
    const spelled = cols.length
      ? cols
          .map((c) => `${c.field} (${c.type}${c.compute ? ", computed" : ""})`)
          .join(", ")
      : "no fields yet";
    return `- ${m.nav_label} [id ${m.id}]: ${spelled}`;
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

  const store = await storeContextFor(client, project.id, message);
  tell({ step: "store", shop: store?.shop_domain ?? null, read: store?.snapshot?.slice?.what ?? null });
  // What already runs on this app. Left out, the designer proposes a
  // rule that exists, or tells the merchant no rule exists when one
  // fires every morning. It goes in the user turn rather than the
  // system prompt because that prompt is cached across projects.
  // Beside it, what the owner's own connected assistant asked for
  // lately: the one piece of intent that lives outside this thread.
  const [{ data: ruleRows }, requests, { data: changeOn }] = await Promise.all([
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
    lookups && store
      ? client.rpc("abo_feature", { p_name: "store_actions" })
      : Promise.resolve({ data: false }),
  ]);
  const rules = describeRules((ruleRows ?? []) as RuleRow[], modules);

  // Every section's columns, so a design that touches one the caller
  // did not have open is both checked and readable.
  const schemas = await schemasFor(client, modules);
  tell({ step: "context", sections: modules.length, rules: (ruleRows ?? []).length });

  // The store tools, when this caller allows them and there is a store
  // to read. Each lookup is told as it comes back and kept once for the
  // receipt: a transient retry that runs the same lookup again is still
  // one thing looked up.
  const lookedUp: string[] = [];
  const heard = new Set<string>();
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
        ...aiStoreTools(toolStore, {
          only: LUKE_TOOLS,
          observe: ({ tool, about, args }) => {
            const key = `${tool}:${JSON.stringify(args)}`;
            if (heard.has(key)) return;
            heard.add(key);
            lookedUp.push(about);
            tell({ step: "lookup", about });
          },
        }),
        // Asking for a change in the shop, when the account allows it.
        // It only ever makes a request the merchant agrees to or not.
        ...(canChange
          ? { propose_store_action: aiProposeTool(toolStore, ({ summary }) => tell({ step: "proposed", summary })) }
          : {}),
      }
    : null;
  // The draft, told only when it changes: a stream of the same words
  // over and over would be a stream of nothing.
  let drafted = "";
  const draft = onWords
    ? (text: string) => {
        const said = text === "" ? "" : draftMessage(text);
        if (said === null || said === drafted) return;
        drafted = said;
        try {
          onWords(said);
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

  const system = buildSystemPrompt(modules, project.name, project.locale, project.currency, store);
  const userTurn = buildUserMessage(
    message,
    moduleId,
    currentSchema ?? (moduleId ? schemas.get(moduleId) ?? null : null),
    currentFeatures,
    rules,
    columnLines(modules, schemas),
    requests
  );

  // The rejected attempt and its errors stay in the turns sent to the
  // model but are never persisted — replaying a malformed reply from
  // history would only teach it to repeat the mistake.
  const attemptTurns: ChatTurn[] = [{ role: "user", content: userTurn }];
  let raw = "";
  let parsed: ReturnType<typeof parseReply> | null = null;
  let repairs = 0;
  // Which gate fired, not just how often something did. The count
  // alone cannot tell a malformed shape from a design that missed the
  // point, and those want opposite remedies.
  const repairErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    tell({ step: "model", attempt: attempt + 1, of: MAX_REPAIR_ATTEMPTS + 1 });
    // Tools on the first attempt only: a repair fixes the reply's shape,
    // and what was looked up is already written into the reply it fixes.
    raw = await callModel({
      system,
      turns: [...history, ...attemptTurns],
      signal,
      lookups: attempt === 0 && tools ? { tools } : undefined,
      onText: draft,
    });
    parsed = parseReply(raw, modules, currentSchema, currentFeatures, (mid) =>
      schemas.get(mid) ?? null
    );

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
      const copies = seededCopies(
        parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans,
        store ? { shop_domain: store.shop_domain, currency: store.currency, counts: store.counts } : null
      );
      if (copies.length) parsed = { ok: false, errors: copies };
    }

    // What the validator actually said — zero problems, or this many on
    // their way back to the model. Not "checked" because time passed.
    tell({ step: "checked", problems: parsed.ok ? 0 : parsed.errors.length });
    if (parsed.ok) break;

    repairs = attempt + 1;
    repairErrors.push(...parsed.errors);
    if (attempt === MAX_REPAIR_ATTEMPTS) break;
    attemptTurns.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Your previous reply was rejected by the validator:\n${parsed.errors
          .map((e) => `- ${e}`)
          .join(
            "\n"
          )}\n\nFix every one of these and reply again with the corrected JSON only. Do not apologise or explain — just the corrected reply. If a module name is already taken, either target the existing module instead of creating a new one, or choose a different name.`,
      }
    );
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
    const plans =
      parsed.reply.type === "blueprint" ? parsed.reply.blueprint.plans : parsed.reply.plans;
    const built = describeBuild(plans, modules, currentSchema?.columns, store);
    tell({ step: "gaps" });
    const gaps = await findGaps(message.trim(), built, signal);
    const existing =
      parsed.reply.type === "blueprint" ? (parsed.reply.blueprint.unmet ?? []) : [];
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

  return { ok: true, reply: parsed.reply, raw, userTurn, repairs, repairErrors, store, unmet, lookedUp };
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

  const bp =
    reply.type === "blueprint"
      ? reply.blueprint
      : { summary: reply.message, plans: reply.plans, unmet };
  const facts = store
    ? { shop_domain: store.shop_domain, currency: store.currency, counts: store.counts }
    : null;

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
