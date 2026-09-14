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
import {
  buildSystemPrompt,
  buildUserMessage,
  callAnthropicChat,
  findGaps,
  parseReply,
  type ChatTurn,
  type StoreContext,
} from "@/lib/ai";
import { describePlan } from "@/lib/describe";
import { storeOverview } from "@/lib/store-read";
import type { AssistantReply, FeatureSchema, ModuleRow, ProjectRow, UiSchema } from "@/lib/types";

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
  projectId: string
): Promise<StoreContext | null> {
  // Through the caller's own client, so a project without a store — or
  // a member who cannot see it — simply gets null.
  const { data: storeRow } = await client
    .from("stores")
    .select("id, shop_domain, timezone, currency")
    .eq("project_id", projectId)
    .eq("status", "connected")
    .maybeSingle();
  if (!storeRow) return null;

  const overview = await storeOverview(client, storeRow.id as string);
  const { data: runs } = await client
    .from("import_runs")
    .select("status")
    .eq("store_id", storeRow.id);
  const runList = (runs ?? []) as Array<{ status: string }>;

  return {
    shop_domain: storeRow.shop_domain as string,
    timezone: storeRow.timezone as string,
    currency: storeRow.currency as string,
    // Counts quoted mid-import are partial, and a design built on "you
    // have 4 orders" is wrong if 4,000 are still arriving.
    importing: runList.length === 0 || runList.some((r) => r.status !== "done"),
    counts: overview?.counts ?? {},
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
  /** Module context for the turn, when the owner is looking at one. */
  moduleId?: string | null;
  signal?: AbortSignal;
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
    }
  | { ok: false; errors: string[]; repairs: number; repairErrors: string[] };

/**
 * Runs the model, repairs what the validator rejects, and fills in the
 * gaps a blueprint failed to mention. Writes nothing.
 */
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
    moduleId = null,
    signal,
  } = input;

  const store = await storeContextFor(client, project.id);
  const system = buildSystemPrompt(modules, project.name, project.locale, project.currency, store);
  const userTurn = buildUserMessage(message, moduleId, currentSchema, currentFeatures);

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
    raw = await callAnthropicChat(system, [...history, ...attemptTurns], signal);
    parsed = parseReply(raw, modules, currentSchema, currentFeatures);

    // Structural gate, enforced here rather than trusted to the prompt.
    if (
      parsed.ok &&
      parsed.reply.type === "plans" &&
      !blueprintShown &&
      parsed.reply.plans.some((pl) => pl.changeType === "NEW_MODULE")
    ) {
      parsed = {
        ok: false,
        errors: [
          'You tried to create new sections before showing the owner a design. Reply with a "blueprint" instead so they can approve it first.',
        ],
      };
    }

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
      errors: parsed?.errors ?? ["The assistant could not produce a valid reply."],
      repairs,
      repairErrors,
    };
  }

  // Gates cover the grammar; this covers the judgment. Run only on a
  // blueprint, because that is the one moment somebody is being asked
  // to approve something, and the only place saying "this does not do
  // X" still changes the outcome.
  if (parsed.reply.type === "blueprint") {
    const built = parsed.reply.blueprint.plans
      .map((pl) => {
        const d = describePlan(pl, modules, currentSchema?.columns, store);
        return [d.title, ...d.lines].join("\n  ");
      })
      .join("\n");
    const gaps = await findGaps(message.trim(), built, signal);
    const existing = parsed.reply.blueprint.unmet ?? [];
    const seen = new Set(existing.map((u) => u.toLowerCase().trim()));
    parsed.reply.blueprint.unmet = [
      ...existing,
      ...gaps.filter((g) => !seen.has(g.toLowerCase().trim())),
    ].slice(0, 6);
  }

  return { ok: true, reply: parsed.reply, raw, userTurn, repairs, repairErrors, store };
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
  store: StoreContext | null
): string | null {
  if (reply.type === "clarify") return null;
  // A reply of plain plans is an edit to something that already
  // exists. It still gets described the same way — the merchant is
  // approving it either way, so they read the same sentences.
  const bp =
    reply.type === "blueprint"
      ? reply.blueprint
      : { summary: reply.message, plans: reply.plans, unmet: [] as string[] };
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
