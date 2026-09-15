import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "@/lib/supabase-server";
import { MAX_REPAIR_ATTEMPTS, runTurn } from "@/lib/engine";
import type { ChatTurn } from "@/lib/ai";
import type {
  AssistantReply,
  FeatureSchema,
  MessageRow,
  ModuleRow,
  ProjectRow,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/chat?projectId=…            — the project's threads, newest first
 * GET /api/chat?projectId=…&id=…       — one thread's messages
 * GET /api/chat?projectId=…&latest=1   — the newest thread and its messages
 *
 * Conversations were being written and never read back, so every reload
 * silently started a new one and the owner lost the thread they were in.
 */
export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { client } = auth;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const id = url.searchParams.get("id");
  const latest = url.searchParams.get("latest");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const { data: threadRows, error: tErr } = await client
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .limit(30);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  const threads = threadRows ?? [];

  const wanted = id ?? (latest ? (threads[0]?.id as string | undefined) : undefined);
  if (!wanted) return NextResponse.json({ threads, conversationId: null, messages: [] });

  // RLS keeps this to the caller's own project; the extra filter guards
  // against an id from a different project of theirs.
  if (!threads.some((t) => t.id === wanted)) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const { data: msgs, error: mErr } = await client
    .from("messages")
    .select("id, role, payload, created_at")
    .eq("conversation_id", wanted)
    .order("created_at", { ascending: true })
    .limit(200);
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  return NextResponse.json({ threads, conversationId: wanted, messages: msgs ?? [] });
}

type SchemaJsonWithFeatures = UiSchema & { features?: FeatureSchema | null };

/** How many past turns to replay. Enough for a full discovery loop. */
const HISTORY_LIMIT = 30;

/**
 * Each turn is a large model call, and the repair loop can triple it.
 * Without a ceiling one stuck client loop runs up an unbounded bill, so
 * cap what a single owner can spend per hour.
 */
const MAX_TURNS_PER_HOUR = 60;

/**
 * POST /api/chat — body: { message, projectId, moduleId?, conversationId? }
 * Runs under the caller's RLS: they can only ever touch their own project's
 * data. Persists the thread so the assistant can ask, then design, then
 * build. Returns { conversationId, reply } or { errors } — never applies.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { message, projectId, moduleId, conversationId } = (await req.json()) as {
      message?: string;
      projectId?: string;
      moduleId?: string | null;
      conversationId?: string | null;
    };
    if (!message?.trim() || !projectId) {
      return NextResponse.json({ error: "message and projectId are required" }, { status: 400 });
    }

    // Warmluke's own assistant can be switched off for an account —
    // it is the one that spends our model budget. Checked here, not
    // only in the panel: a switch enforced by hidden UI is not a
    // switch. Their own AI is a separate switch and is unaffected;
    // so is approving a design that has already been made.
    const { data: chatOn } = await client.rpc("abo_feature", { p_name: "chat" });
    if (chatOn === false) {
      return NextResponse.json(
        {
          error:
            "Warmluke's assistant is turned off for this account. Your own AI can still design and build — or ask us to turn it back on.",
        },
        { status: 403 }
      );
    }

    // RLS ensures this only returns the caller's own project.
    const { data: project, error: projErr } = await client
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .limit(1);
    if (projErr) throw new Error(projErr.message);
    const proj = project?.[0] as ProjectRow | undefined;
    if (!proj) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    // A member can SEE this project — that is what a staff login is
    // for — and could reach here. Two things went wrong when they
    // did: their own free allowance paid for a turn on somebody
    // else's app, which is ten more builds per person invited, and
    // the reply could not be saved afterwards because conversations
    // belong to the owner. We paid for a model call that nobody got.
    //
    // The People settings already promise this: they cannot change
    // how the app is built.
    if (proj.owner_id !== auth.userId) {
      return NextResponse.json(
        { error: "Only the owner of this app can build with the assistant." },
        { status: 403 }
      );
    }

    // RLS scopes this count to the caller's own conversations.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentTurns } = await client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("role", "user")
      .gte("created_at", since);
    if ((recentTurns ?? 0) >= MAX_TURNS_PER_HOUR) {
      return NextResponse.json(
        {
          error: `You've hit the limit of ${MAX_TURNS_PER_HOUR} assistant messages an hour. Try again shortly.`,
        },
        { status: 429 }
      );
    }

    const { data: modules, error: modErr } = await client
      .from("modules")
      .select("*")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (modErr) throw new Error(modErr.message);

    const moduleList = (modules ?? []) as ModuleRow[];

    let currentSchema: UiSchema | null = null;
    let currentFeatures: FeatureSchema | null = null;
    if (moduleId) {
      const { data: schemaRow } = await client
        .from("ui_schemas")
        .select("*")
        .eq("module_id", moduleId)
        .order("version", { ascending: false })
        .limit(1);
      const row = schemaRow?.[0] as UiSchemaRow | undefined;
      if (row) {
        const sj = row.schema_json as SchemaJsonWithFeatures;
        currentSchema = { columns: sj.columns };
        currentFeatures = sj.features ?? null;
      }
    }

    // ── Conversation: resume the thread, or start one ──
    let convId = conversationId ?? null;
    if (convId) {
      // RLS scopes this to the caller; a foreign id simply won't resolve.
      const { data: existing } = await client
        .from("conversations")
        .select("id")
        .eq("id", convId)
        .eq("project_id", projectId)
        .limit(1);
      if (!existing?.[0]) convId = null;
    }
    // The row is created only once a turn succeeds — creating it up
    // front left an empty conversation behind every time a reply failed
    // validation.
    const isNewConversation = !convId;

    const { data: historyRows, error: histErr } = convId
      ? await client
          .from("messages")
          .select("role, content, ptype:payload->>type, said:payload->>text")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: true })
          .limit(HISTORY_LIMIT)
      : { data: [], error: null };
    if (histErr) throw new Error(histErr.message);

    type HistoryRow = Pick<MessageRow, "role" | "content"> & {
      ptype: string | null;
      said: string | null;
    };
    const rows = (historyRows ?? []) as HistoryRow[];

    // Replay the owner's actual words, not the CONTEXT-wrapped turn we
    // sent at the time: that block is a snapshot of the schema as it was,
    // and a thread of stale snapshots both costs tokens and contradicts
    // the fresh one on the newest turn.
    const history = rows.map(
      (m): ChatTurn => ({ role: m.role, content: m.role === "user" ? (m.said ?? m.content) : m.content })
    );

    // Has the owner already seen a design for this thread? New sections may
    // only be built after one — otherwise the assistant can skip straight to
    // creating things the owner never agreed to.
    const blueprintShown = rows.some((m) => m.ptype === "blueprint");

    // The store the assistant is designing on top of, if there is one.
    // One engine, two callers. The MCP tool designs a merchant's
    // request through this same function, so the gates cannot drift
    // apart between the two ways in.
    // Spent before the model runs. One turn here is two to four
    // calls on our key — a design, its repairs, and the pass that
    // works out what it misses — so a loop that pays only on success
    // would not pay at all.
    const { data: allowance, error: spendErr } = await client.rpc("abo_spend_turn");
    if (spendErr) throw new Error(spendErr.message);
    const turns = allowance as
      | { ok: boolean; used: number; free: number; spend_id?: string }
      | null;
    if (turns && !turns.ok) {
      return NextResponse.json(
        {
          error: `You have used all ${turns.free} free builds on Warmluke's own assistant.`,
          out_of_turns: true,
          used: turns.used,
          free: turns.free,
        },
        { status: 402 }
      );
    }

    const turn = await runTurn({
      client,
      project: proj,
      modules: moduleList,
      message,
      history,
      currentSchema,
      currentFeatures,
      blueprintShown,
      moduleId: moduleId ?? null,
      signal: req.signal,
    });

    if (!turn.ok) {
      // Our engine could not produce something it trusts. Charging
      // for that is charging for our own failure.
      // The id is what proves this is the server undoing its own
      // failure. It stays in this request and is never sent back.
      await client.rpc("abo_refund_turn", { p_spend: turns?.spend_id ?? null });
      return NextResponse.json(
        {
          conversationId: convId,
          repairs: turn.repairs,
          errors: turn.errors,
          hint: `The assistant tried ${MAX_REPAIR_ATTEMPTS + 1} times and its plan still failed validation, so nothing was changed. Try rephrasing your request.`,
        },
        { status: 200 }
      );
    }

    if (isNewConversation) {
      const { data: created, error: convErr } = await client
        .from("conversations")
        .insert({ project_id: projectId, title: message.trim().slice(0, 80) })
        .select("id")
        .single();
      if (convErr) throw new Error(convErr.message);
      convId = created.id as string;
    }

    await persistTurn(
      client,
      convId!,
      turn.userTurn,
      message.trim(),
      turn.raw,
      turn.reply,
      turn.repairErrors
    );
    // A thread is named after whatever was typed first, which is how
    // six of them end up called "hello". Once a design exists there is
    // something better to call it — and only then, because renaming on
    // every turn would move a thread the owner was looking for.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (isNewConversation || looksLikeAGreeting(message)) {
      const named = titleFor(turn.reply);
      if (named) patch.title = named;
    }
    await client.from("conversations").update(patch).eq("id", convId);

    return NextResponse.json({ conversationId: convId, reply: turn.reply, repairs: turn.repairs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function persistTurn(
  client: SupabaseClient,
  conversationId: string,
  userContent: string,
  /** What the owner actually typed, kept for replay and for the UI. */
  said: string,
  assistantRaw: string,
  reply: AssistantReply,
  /** Every validator message the model had to fix on the way here. */
  repairErrors: string[]
) {
  // Both rows go in one insert, so the default now() gives them the
  // SAME created_at and "order by created_at" is a coin flip — the
  // reply came back above the question it answered. Stamp them apart.
  const t = Date.now();
  const { error } = await client.from("messages").insert([
    {
      conversation_id: conversationId,
      role: "user",
      content: userContent,
      payload: { kind: "user", text: said },
      created_at: new Date(t).toISOString(),
    },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: assistantRaw,
      payload: repairErrors.length > 0 ? { ...reply, repairErrors } : reply,
      created_at: new Date(t + 1).toISOString(),
    },
  ]);
  if (error) throw new Error(error.message);
}

/** Words that say nothing about what the thread is for. */
function looksLikeAGreeting(message: string): boolean {
  return /^(hi|hey|hello|yo|test|hola|namaste)\b[\s!.?]*$/i.test(message.trim());
}

/**
 * What to call a thread, taken from what the assistant decided to do
 * rather than from the first thing anybody typed.
 */
function titleFor(reply: AssistantReply): string | null {
  const from =
    reply.type === "blueprint"
      ? (reply.blueprint.summary ?? reply.message)
      : reply.type === "plans"
        ? reply.message
        : null;
  const line = from?.split(/[.\n]/)[0]?.trim();
  return line && line.length > 3 ? line.slice(0, 80) : null;
}
