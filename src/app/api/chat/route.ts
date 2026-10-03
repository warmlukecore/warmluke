import { NextResponse, after } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { lukeSettings, modelFor } from "@/lib/luke-models";
import { metered } from "@/lib/usage";
import { tapeHeaders } from "@/lib/model-tape";
import { runTurn } from "@/lib/engine";
import { modelErrorKindOf } from "@/lib/ai";
import { TOKEN_LEFT_MS, finishTurn, lapsesAt, settleAnswer, turnContext, type TurnJob } from "@/lib/turn-run";
import { start } from "workflow/api";
import { lukeTurn } from "@/workflows/luke-turn";
import { TITLE_MAX } from "@/lib/types";
import type { ProjectRow, TurnEvent } from "@/lib/types";

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
    .select(
      "id, title, created_at, updated_at, asked_by, created_by, messages(ptype:payload->>type, pstatus:payload->>status)"
    )
    .eq("project_id", projectId);
  // ponytail: paged by updated_at alone; two threads moved in the same microsecond could straddle a page.
  if (before) list = list.lt("updated_at", before);
  // Their words, not a pattern: % and _ are searched for as themselves.
  if (q) list = list.ilike("title", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  // One more than a page, to know whether there is another.
  const { data: threadRows, error: tErr } = await list.order("updated_at", { ascending: false }).limit(THREAD_PAGE + 1);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  const more = (threadRows?.length ?? 0) > THREAD_PAGE;
  const page = (threadRows ?? []).slice(0, THREAD_PAGE);
  // The owner reads the threads of the people they let build (0146): each says whose it is.
  const others = [...new Set(page.map((t) => t.created_by as string | null).filter((u) => u && u !== auth.userId))];
  const { data: named } = others.length
    ? await client.rpc("abo_names_for", { p_project: projectId, p_ids: others })
    : { data: [] };
  const nameOf = new Map(((named ?? []) as Array<{ user_id: string; name: string }>).map((n) => [n.user_id, n.name]));
  const threads = page.map(({ messages, created_by, ...t }) => {
    const kinds = (messages ?? []) as Array<{ ptype: string | null; pstatus: string | null }>;
    return {
      ...t,
      mine: !created_by || created_by === auth.userId,
      by: created_by && created_by !== auth.userId ? (nameOf.get(created_by) ?? "A teammate") : null,
      // A build the server recorded, or a receipt the panel wrote before it did.
      built: kinds.filter((k) => k.ptype === "applied" || (k.ptype === "build" && k.pstatus === "built")).length,
      answers: kinds.filter((k) => k.ptype === "answer").length,
    };
  });

  // The latest of your own: opening Luke never lands you in a teammate's thread.
  const wanted = id ?? (latest ? (threads.find((t) => t.mine)?.id as string | undefined) : undefined);
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

/** How often a running turn looks for its stop. */
const STOP_POLL_MS = 1500;

/**
 * DELETE /api/chat { turn } — stops a turn: its answer's line says so,
 * and the turn, wherever it runs, sees that and stops. A turn already
 * answered is not touched. RLS keeps it to the caller's own messages.
 */
export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { turn } = ((await req.json().catch(() => ({}))) ?? {}) as { turn?: unknown };
  if (typeof turn !== "string" || !/^[0-9a-f-]{36}$/i.test(turn)) {
    return NextResponse.json({ error: "turn is required" }, { status: 400 });
  }
  const { data, error } = await auth.client
    .from("messages")
    .update({ payload: { type: "stopped", stopped_at: new Date().toISOString() } })
    .eq("id", turn)
    .eq("payload->>type", "answering")
    .select("conversation_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const at = data?.[0]?.conversation_id as string | undefined;
  if (at) await auth.client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", at);
  return NextResponse.json({ stopped: !!at });
}

/**
 * Each turn is a large model call, and the repair loop can triple it.
 * Without a ceiling one stuck client loop runs up an unbounded bill, so
 * cap what a single owner can spend per hour.
 */
const MAX_TURNS_PER_HOUR = 60;

/** How often a draft of Luke's words is sent: often enough to read as typing, not a line a token. */
const WORDS_EVERY_MS = 80;

/**
 * POST /api/chat — body: { message, projectId, moduleId?, conversationId?, alertId? }
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
    // The body before anything that waits, as /api/apply does: a browser
    // that goes away in the first moments takes its unread body with it,
    // and the question it asked was never kept. Read at once, the turn
    // carries on without it.
    const {
      message,
      projectId,
      moduleId,
      conversationId,
      model: askedModel,
      alertId,
    } = ((await req.json().catch(() => ({}))) ?? {}) as {
      message?: string;
      projectId?: string;
      moduleId?: string | null;
      conversationId?: string | null;
      /** The model picked in the panel; used only when this account may use it. */
      model?: unknown;
      /** Asked about something Luke noticed (0163): the new thread is kept on it. */
      alertId?: unknown;
    };
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;
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
    // for — and could reach here. Only one the owner lets build may ask
    // Luke (0146): their conversations are their own, and the turn is
    // paid from the owner's included designs (abo_spend_turn below),
    // not ten more of their own per person invited.
    if (proj.owner_id !== auth.userId) {
      const { data: seat } = await client
        .from("project_members")
        .select("can_build")
        .eq("project_id", projectId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (!seat?.can_build) {
        return NextResponse.json(
          { error: "The owner of this app hasn't let you build with Luke. Ask them to switch it on in People." },
          { status: 403 }
        );
      }
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
    // Made once the turn is paid for, with the question already in it
    // (below): a thread is never left empty, and one left mid-answer has
    // the question to come back to.
    const isNewConversation = !convId;

    // The sections, the open one's schema and the thread so far: read the
    // same way a durable leg reads them (lib/turn-run.ts).
    const ctx = await turnContext(client, proj, {
      projectId,
      moduleId: moduleId ?? null,
      conversationId: convId,
      userId: auth.userId,
    });
    const { moduleList, currentSchema, currentFeatures, history, blueprintShown } = ctx;

    // The store the assistant is designing on top of, if there is one.
    // One engine, two callers. The MCP tool designs a merchant's
    // request through this same function, so the gates cannot drift
    // apart between the two ways in.
    // Spent before the model runs. One turn here is two to four
    // calls on our key — a design, its repairs, and the pass that
    // works out what it misses — so a loop that pays only on success
    // would not pay at all.
    const { data: allowance, error: spendErr } = await client.rpc("abo_spend_turn", { p_project: projectId });
    if (spendErr) throw new Error(spendErr.message);
    const turns = allowance as { ok: boolean; used: number; free: number; spend_id?: string } | null;
    if (turns && !turns.ok) {
      return NextResponse.json(
        {
          error:
            proj.owner_id === auth.userId
              ? `You have used all ${turns.free} included design${turns.free === 1 ? "" : "s"} from Warmluke.`
              : `This app has used all ${turns.free} included design${turns.free === 1 ? "" : "s"} from Warmluke. Its owner can ask us for more.`,
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
    //
    // Not when the browser goes. Going back, opening another thread or
    // closing the tab is not "stop": the answer is theirs whether or not
    // they are watching, and it lands where the question is. Stop is its
    // own request (DELETE below), which marks the answer's line, and the
    // turn looks for that mark while it runs.
    const halt = new AbortController();

    // The question, kept the moment it is asked, and a line where its
    // answer will go. A new thread is made now, with the question in it.
    const said = message.trim();
    if (!convId) {
      const { data: created, error: convErr } = await client
        .from("conversations")
        .insert({ project_id: projectId, title: said.slice(0, TITLE_MAX) })
        .select("id")
        .single();
      if (convErr || !created) {
        if (refundable) await client.rpc("abo_refund_turn", { p_spend: refundable });
        throw new Error(convErr?.message ?? "could not start the conversation");
      }
      convId = created.id as string;
      // Not linked is not a failed question: the answer still comes, and
      // the next tap on the alert asks again.
      if (typeof alertId === "string") {
        await client.rpc("abo_alert_link", { p_alert: alertId, p_conversation: convId });
      }
    }
    const askedAt = Date.now();
    const { data: opened, error: openErr } = await client
      .from("messages")
      .insert([
        {
          conversation_id: convId,
          role: "user",
          content: said,
          payload: { kind: "user", text: said },
          created_at: new Date(askedAt).toISOString(),
        },
        {
          conversation_id: convId,
          role: "assistant",
          content: "",
          payload: { type: "answering", started_at: new Date(askedAt).toISOString() },
          created_at: new Date(askedAt + 1).toISOString(),
        },
      ])
      .select("id, role");
    const askedId = opened?.find((r) => r.role === "user")?.id as string | undefined;
    const answerId = opened?.find((r) => r.role === "assistant")?.id as string | undefined;
    if (openErr || !askedId || !answerId) {
      if (refundable) await client.rpc("abo_refund_turn", { p_spend: refundable });
      throw new Error(openErr?.message ?? "could not keep the question");
    }
    await client.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
    const thread = convId;
    const job: TurnJob = {
      userId: auth.userId,
      projectId,
      moduleId: moduleId ?? null,
      conversationId: thread,
      askedId,
      answerId,
      message,
      askedModel: typeof askedModel === "string" ? askedModel : null,
      askedAt,
      isNewConversation,
    };
    const settle = (payload: Record<string, unknown>, content = "") => settleAnswer(client, job, payload, content);

    // A durable turn (workflows/luke-turn.ts): run in legs past any one
    // function's time, the charge and its giving back with it. The lines
    // the browser reads come from the run's own stream. A run that cannot
    // start leaves the turn to this request, as it always ran.
    // ponytail: the steps act with the owner's own token, carried in the
    // run's input until it lapses (about an hour from when the browser got
    // it); a token with too little life left for a whole turn runs the turn
    // here. A token minted per turn would lift both.
    const token = (req.headers.get("authorization") ?? "").slice(7).trim();
    if (process.env.LUKE_WORKFLOW === "1" && lapsesAt(token) - Date.now() > TOKEN_LEFT_MS) {
      try {
        const run = await start(lukeTurn, [{ ...job, token, spendId: refundable }]);
        refundable = null;
        const lines = new TransformStream<unknown, Uint8Array>({
          // The turn named at once, as the run starts: its first leg
          // begins seconds later, and Stop needs a line to mark.
          start(controller) {
            const accepted: TurnEvent = { step: "accepted", conversationId: thread, turn: answerId };
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(accepted)}\n`));
          },
          transform(chunk, controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(chunk)}\n`));
          },
        });
        return new Response(run.readable.pipeThrough(lines), {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "x-workflow-run-id": run.runId,
            ...tapeHeaders(),
          },
        });
      } catch (e) {
        console.error(`[durable turn] not started, running here: ${e instanceof Error ? e.message : e}`);
      }
    }

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

    const work = async (say: (event: TurnEvent) => void): Promise<Record<string, unknown>> => {
      // Every step told is also kept, for the trace the turn leaves (0132).
      const steps: TurnEvent[] = [];
      const tell = (event: TurnEvent) => {
        steps.push(event);
        say(event);
      };
      try {
        tell({ step: "accepted", conversationId: thread, turn: answerId });
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

        const done = await finishTurn(
          client,
          job,
          ctx,
          turn,
          took(),
          steps,
          (fn) => after(fn),
          luke.shows === "tokens" || luke.shows === "cost"
        );
        if (done.charged) refundable = null;
        return done.last;
      } catch (e) {
        const why = e instanceof Error ? e.message : "Unknown error";
        // Kept as what it was when the model was not there, for the console (0165).
        const failed = modelErrorKindOf(why);
        if (!halt.signal.aborted) await settle({ type: "unanswered", message: why, ...(failed ? { failed } : {}) });
        return { error: why, conversationId: thread };
      } finally {
        clearInterval(stopWatch);
        if (refundable) await client.rpc("abo_refund_turn", { p_spend: refundable });
      }
    };

    // Stop is a mark on the answer's line, made by any server that took
    // the request; this one looks for it while the turn runs.
    // ponytail: one read every STOP_POLL_MS per running turn; a pub/sub channel if turns get many.
    const stopWatch = setInterval(async () => {
      const { data } = await client.from("messages").select("payload->>type").eq("id", answerId).maybeSingle();
      if ((data as { type?: string } | null)?.type === "stopped") halt.abort();
    }, STOP_POLL_MS);

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
        const done = work(line);
        // Held open past the reader: a turn left mid-answer still lands.
        after(() => done.then(() => undefined));
        const last = await done;
        quiet();
        line(last);
        try {
          controller.close();
        } catch {
          /* already closed by the reader */
        }
      },
      cancel() {
        // The reader has gone (back, another thread, the tab closed): the
        // turn goes on, and its answer is kept where the question is.
        quiet();
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
