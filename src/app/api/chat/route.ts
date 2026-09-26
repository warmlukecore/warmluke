import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "@/lib/supabase-server";
import { lukeSettings, modelFor } from "@/lib/luke-models";
import { metered } from "@/lib/usage";
import { tapeHeaders } from "@/lib/model-tape";
import { MAX_REPAIR_ATTEMPTS, runTurn } from "@/lib/engine";
import { noteJudgement } from "@/lib/judge";
import type { ChatTurn } from "@/lib/ai";
import { TITLE_MAX } from "@/lib/types";
import type {
  AssistantReply,
  FeatureSchema,
  MessageRow,
  ModuleRow,
  ProjectRow,
  TurnEvent,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/chat?projectId=…            — the project's threads, newest first
 *   &before=<updated_at>               — the page of threads older than that
 *   &q=…                               — threads whose name has these words
 * GET /api/chat?projectId=…&id=…       — one thread's messages
 * GET /api/chat?projectId=…&latest=1   — the newest thread and its messages
 *
 * Conversations were being written and never read back, so every reload
 * silently started a new one and the owner lost the thread they were in.
 */
/** Past threads listed at a time; the list asks for the next page when it is wanted. */
const THREAD_PAGE = 30;

export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { client } = auth;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const id = url.searchParams.get("id");
  const latest = url.searchParams.get("latest");
  const before = url.searchParams.get("before");
  const q = url.searchParams.get("q")?.trim().slice(0, 100);
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  // With the kind of each message only, so the list can say what a
  // thread holds ("2 built · 3 answers") without a second query.
  // ponytail: reads every message's type; a count kept on conversations if threads get long.
  let list = client
    .from("conversations")
    .select("id, title, created_at, updated_at, messages(ptype:payload->>type, pstatus:payload->>status)")
    .eq("project_id", projectId);
  // ponytail: paged by updated_at alone; two threads moved in the same microsecond could straddle a page.
  if (before) list = list.lt("updated_at", before);
  // Their words, not a pattern: % and _ are searched for as themselves.
  if (q) list = list.ilike("title", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  // One more than a page, to know whether there is another.
  const { data: threadRows, error: tErr } = await list.order("updated_at", { ascending: false }).limit(THREAD_PAGE + 1);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  const more = (threadRows?.length ?? 0) > THREAD_PAGE;
  const threads = (threadRows ?? []).slice(0, THREAD_PAGE).map(({ messages, ...t }) => {
    const kinds = (messages ?? []) as Array<{ ptype: string | null; pstatus: string | null }>;
    return {
      ...t,
      // A build the server recorded, or a receipt the panel wrote before it did.
      built: kinds.filter((k) => k.ptype === "applied" || (k.ptype === "build" && k.pstatus === "built")).length,
      answers: kinds.filter((k) => k.ptype === "answer").length,
    };
  });

  const wanted = id ?? (latest ? (threads[0]?.id as string | undefined) : undefined);
  if (!wanted) return NextResponse.json({ threads, more, conversationId: null, messages: [] });

  // RLS keeps this to the caller's own project; the extra filter guards
  // against an id from a different project of theirs. A thread opened
  // from further down the list is not on the first page, so it is asked
  // for by itself rather than refused.
  if (!threads.some((t) => t.id === wanted)) {
    const { data: own } = await client
      .from("conversations")
      .select("id")
      .eq("id", wanted)
      .eq("project_id", projectId)
      .maybeSingle();
    if (!own) return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  // The same trap as the replay below: ascending with a limit keeps the
  // oldest, so a long thread reopened showed its first two hundred
  // messages and none of the recent ones. Newest first, then reversed.
  const { data: msgs, error: mErr } = await client
    .from("messages")
    .select("id, role, payload, created_at")
    .eq("conversation_id", wanted)
    .order("created_at", { ascending: false })
    .limit(200);
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  return NextResponse.json({
    threads,
    more,
    conversationId: wanted,
    messages: [...(msgs ?? [])].reverse(),
  });
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

/** How often a draft of Luke's words is sent: often enough to read as typing, not a line a token. */
const WORDS_EVERY_MS = 80;

/**
 * POST /api/chat — body: { message, projectId, moduleId?, conversationId? }
 * Runs under the caller's RLS: they can only ever touch their own project's
 * data. Persists the thread so the assistant can ask, then design, then
 * build. Never applies.
 *
 * Refusals — not signed in, switched off, out of turns — come back as
 * JSON with a status. A turn that runs comes back as lines of JSON
 * (application/x-ndjson): each step as it happens, then one last line
 * holding { conversationId, reply } or { errors, hint } or { error }.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const {
      message,
      projectId,
      moduleId,
      conversationId,
      model: askedModel,
    } = (await req.json()) as {
      message?: string;
      projectId?: string;
      moduleId?: string | null;
      conversationId?: string | null;
      /** The model picked in the panel; used only when this account may use it. */
      model?: unknown;
    };
    if (!message?.trim() || !projectId) {
      return NextResponse.json({ error: "message and projectId are required" }, { status: 400 });
    }

    // Warmluke's own assistant can be switched off for an account —
    // it is the one that spends our model budget. Checked here, not
    // only in the panel: a switch enforced by hidden UI is not a
    // switch. Their own AI is a separate switch and is unaffected;
    // so is approving a design that has already been made.
    // `=== false` let an ERROR through: a switch that cannot be read
    // is not a switch that is on. The failure that matters is the
    // database being unreachable or the function being renamed, and
    // both used to end in the model running anyway — on our budget,
    // for an account that may have been turned off precisely because
    // of what it was doing.
    const { data: chatOn, error: chatGate } = await client.rpc("abo_feature", {
      p_name: "chat",
    });
    if (chatGate || chatOn === false) {
      return NextResponse.json(
        {
          error:
            "Luke is turned off for this account. Your own AI can still design and build — or ask us to turn Luke back on.",
        },
        { status: 403 }
      );
    }

    // RLS ensures this only returns the caller's own project.
    const { data: project, error: projErr } = await client.from("projects").select("*").eq("id", projectId).limit(1);
    if (projErr) throw new Error(projErr.message);
    const proj = project?.[0] as ProjectRow | undefined;
    if (!proj) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    // A member can SEE this project — that is what a staff login is
    // for — and could reach here. Two things went wrong when they
    // did: their own included-design allowance paid for a turn on
    // somebody else's app, which is ten more designs per person
    // invited, and
    // the reply could not be saved afterwards because conversations
    // belong to the owner. We paid for a model call that nobody got.
    //
    // The People settings already promise this: they cannot change
    // how the app is built.
    if (proj.owner_id !== auth.userId) {
      return NextResponse.json({ error: "Only the owner of this app can build with Luke." }, { status: 403 });
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
          // Newest first, then turned back round below. Ascending with a
          // limit keeps the OLDEST rows, so past this many messages the
          // assistant was replaying the start of the conversation for
          // ever and had no idea what had just been decided — it asked
          // again for answers it had been given, and designed against
          // requirements the owner had already replaced.
          .order("created_at", { ascending: false })
          .limit(HISTORY_LIMIT)
      : { data: [], error: null };
    if (histErr) throw new Error(histErr.message);

    type HistoryRow = Pick<MessageRow, "role" | "content"> & {
      ptype: string | null;
      said: string | null;
    };
    // Back into the order they were said in; a model reading a
    // conversation backwards is worse than one reading half of it.
    const rows = [...((historyRows ?? []) as HistoryRow[])].reverse();

    // Replay the owner's actual words, not the CONTEXT-wrapped turn we
    // sent at the time: that block is a snapshot of the schema as it was,
    // and a thread of stale snapshots both costs tokens and contradicts
    // the fresh one on the newest turn.
    const history = rows.map((m): ChatTurn => ({
      role: m.role,
      content: m.role === "user" ? (m.said ?? m.content) : m.content,
    }));

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
    const turns = allowance as { ok: boolean; used: number; free: number; spend_id?: string } | null;
    if (turns && !turns.ok) {
      return NextResponse.json(
        {
          error: `You have used all ${turns.free} included design${turns.free === 1 ? "" : "s"} from Warmluke.`,
          out_of_turns: true,
          used: turns.used,
          free: turns.free,
        },
        { status: 402 }
      );
    }

    // From here the answer arrives in lines — what the turn is doing,
    // then the reply. Everything above answers in one piece with a
    // status code, and still does; a stream is committed to 200 the
    // moment it opens, so whatever goes wrong after this point is said
    // in its last line instead.
    //
    // The turn that may still be given back. Cleared only once a
    // design has been written down. Every other way out — a reply that
    // is not a design, a validator that gave up, a throw anywhere after
    // the charge — hands it back in `finally`. It used to be two
    // refunds on two named paths, and a throw between them (the model
    // down, the row that would not insert) kept the turn: charged for
    // our own failure. One place now, so a new exit cannot forget.
    //
    // The id is what proves this is the server undoing its own spend.
    // It stays in this request and is never sent back.
    let refundable: string | null = turns?.spend_id ?? null;
    // Stops the model call when the browser goes: the request's own
    // signal when the connection drops, the stream's cancel when the
    // reader lets go. Either is enough; both are wired.
    const halt = new AbortController();
    req.signal.addEventListener("abort", () => halt.abort());

    // Luke's words as they are written, one line at most every
    // WORDS_EVERY_MS: a fast model would otherwise send a line a token.
    // Each line is the draft whole, so one dropped costs nothing. When
    // the turn ends the one still waiting is dropped, so no draft can
    // arrive after the reply it was a draft of.
    let say: ((o: unknown) => void) | null = null;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    let latest = "";
    let phase: string | undefined;
    let sentAt = 0;
    const send = () => {
      waiting = null;
      sentAt = Date.now();
      say?.({ words: latest, ...(phase ? { phase } : {}) });
    };
    const words = (text: string, next?: string) => {
      latest = text;
      phase = next;
      if (text === "") {
        // Starting over is said at once, so rejected words do not linger.
        if (waiting) clearTimeout(waiting);
        send();
        return;
      }
      if (!waiting) waiting = setTimeout(send, Math.max(0, WORDS_EVERY_MS - (Date.now() - sentAt)));
    };
    const quiet = () => {
      if (waiting) clearTimeout(waiting);
      waiting = null;
      say = null;
    };

    const work = async (tell: (event: TurnEvent) => void): Promise<Record<string, unknown>> => {
      try {
        tell({ step: "accepted" });
        // The model they picked, if the account may use it; the default
        // otherwise. The server's own model goes as no choice at all, so
        // the turn is the one it always was.
        const luke = await lukeSettings(client, auth.userId);
        const picked = modelFor(luke, askedModel);
        const [turn, took] = await metered(() =>
          runTurn({
            client,
            project: proj,
            modules: moduleList,
            message,
            history,
            currentSchema,
            currentFeatures,
            blueprintShown,
            moduleId: moduleId ?? null,
            // Luke may look up what the snapshot does not hold.
            lookups: true,
            signal: halt.signal,
            onEvent: tell,
            onWords: words,
            model: picked && picked !== luke.server ? picked : undefined,
          })
        );

        if (!turn.ok) {
          // Our engine could not produce something it trusts. Charging
          // for that is charging for our own failure.
          return {
            conversationId: convId,
            repairs: turn.repairs,
            errors: turn.errors,
            hint: `The assistant tried ${MAX_REPAIR_ATTEMPTS + 1} times and its plan still failed validation, so nothing was changed. Try rephrasing your request.`,
          };
        }

        if (isNewConversation) {
          const { data: created, error: convErr } = await client
            .from("conversations")
            .insert({ project_id: projectId, title: message.trim().slice(0, TITLE_MAX) })
            .select("id")
            .single();
          if (convErr) throw new Error(convErr.message);
          convId = created.id as string;
        }

        // Written here, by the server, from what the server actually
        // read — and before the row is stored, so the thread keeps the
        // receipt rather than only this response carrying it. The model
        // is never asked to attest that it looked; an assertion from
        // the thing being checked is not a check. Only an answer about
        // the store gets one: a greeting read no rows.
        // What the calls took, kept with the reply so a reload says the same.
        const usage = took();
        if (usage) turn.reply.usage = usage;
        if (turn.reply.type === "answer" && turn.reply.kind === "store") {
          turn.reply.grounding = {
            kind: "store_snapshot",
            last_synced_at: turn.store?.snapshot?.last_synced_at ?? null,
            shop: turn.store?.shop_domain ?? "",
            ...(turn.lookedUp.length ? { looked_up: turn.lookedUp } : {}),
          };
        }

        const replyId = await persistTurn(
          client,
          convId!,
          turn.userTurn,
          message.trim(),
          turn.raw,
          turn.reply,
          turn.repairErrors
        );

        // Only a turn that produced a design, and got it written down,
        // counts.
        //
        // The card shown when the counter runs out says "Asking about
        // your store still works" — and asking is what had been using
        // it up. Every question answered, and every question the
        // assistant asked BACK, spent one of the ten, so a single
        // design that needed one round of clarifying cost two or
        // three. Charged only here rather than never charged, because
        // the charge has to happen before the model runs: a client in
        // a loop pays for its own stop.
        if (turn.reply.type === "plans" || turn.reply.type === "blueprint") {
          refundable = null;
          // A second opinion on the design, taken after the reply has
          // gone out and written down where nothing reads it yet. A
          // clarify or an answer has no design to judge.
          const reply = turn.reply;
          const store = turn.store;
          after(() =>
            noteJudgement(client, {
              projectId: proj.id,
              source: "chat",
              ref: replyId,
              request: message.trim(),
              plans: reply.type === "blueprint" ? reply.blueprint.plans : reply.plans,
              modules: moduleList,
              columns: currentSchema?.columns,
              store,
              unmet: turn.unmet,
            })
          );
        }
        // A thread is named after whatever was typed first, which is
        // how six of them end up called "hello". Once a design exists
        // there is something better to call it — and only then, because
        // renaming on every turn would move a thread the owner was
        // looking for.
        //
        // The model names the conversation on every reply now, and keeps
        // the name while the subject holds, so the list reads as what each
        // thread was about ("Pending COD payments") rather than "hello".
        // Without one, the old rule: named once, from the design.
        //
        // A name the owner gave in the list is theirs (0126): the reply
        // moves the thread up, and leaves its name alone.
        const named =
          turn.reply.title ?? (isNewConversation || looksLikeAGreeting(message) ? titleFor(turn.reply) : null);
        await client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
        if (named) {
          await client.from("conversations").update({ title: named }).eq("id", convId).eq("named_by_owner", false);
        }

        // The reply's row, so the panel can show it under that id and a
        // reload of the thread knows which reply it already has on screen.
        return { conversationId: convId, reply: turn.reply, repairs: turn.repairs, replyId };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Unknown error" };
      } finally {
        if (refundable) await client.rpc("abo_refund_turn", { p_spend: refundable });
      }
    };

    // One JSON object per line. Lines with a `step` are the turn
    // talking; the last line, without one, is what the route used to
    // return whole.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (o: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
          } catch {
            // The reader has gone. The work goes on: a reply the model
            // finished is saved to the thread either way, and the turn
            // is settled either way.
          }
        };
        say = line;
        const last = await work(line);
        quiet();
        line(last);
        try {
          controller.close();
        } catch {
          /* already closed by the reader */
        }
      },
      cancel() {
        quiet();
        halt.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // Whether this server's model calls are recorded or played back
        // (model-tape.ts), so a check can tell it is talking to the server
        // it thinks it is. Never set in production, where taping is off.
        ...tapeHeaders(),
      },
    });
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
): Promise<string | null> {
  // Both rows go in one insert, so the default now() gives them the
  // SAME created_at and "order by created_at" is a coin flip — the
  // reply came back above the question it answered. Stamp them apart.
  const t = Date.now();
  const { data, error } = await client
    .from("messages")
    .insert([
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
    ])
    .select("id, role");
  if (error) throw new Error(error.message);
  // The reply's own row, so a judgement written later can point at it.
  return (data?.find((r) => r.role === "assistant")?.id as string | undefined) ?? null;
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
  return line && line.length > 3 ? line.slice(0, TITLE_MAX) : null;
}
