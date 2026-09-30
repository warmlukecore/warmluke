// An ask from the merchant's own AI, run as a Luke turn in its own thread
// and ended there (lib/client-turn): a design settled as a request and
// built when the merchant said it may be, or left waiting for their yes;
// a question put to them, answered in the same thread; a stop honoured.
// Written on the line their panel shows and the assistant reads back.
//
// It used to live and die inside the request that asked: past the wait,
// a question, a failure or a timeout left nothing behind at all.
//
// The model is stood in for, as check-turn-legs does, so nothing is taped
// and nothing is paid: the turn, the doors (0139), the request and the
// build are all real, on the check project, as a connected client.
//
//   ENV_FILE=.env.check.local APP_URL=http://127.0.0.1:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-client-turn.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsClient } from "./client-session.mjs";
import { throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

// The model, stood in for, at an address of its own; nothing is taped.
delete process.env.MODEL_TAPE;
for (const k of ["ANTHROPIC_PLAN_MODEL", "ANTHROPIC_CRITIC_MODEL", "ANTHROPIC_MEMORY_MODEL", "ANTHROPIC_TALK_MODEL"])
  delete process.env[k];
process.env.ANTHROPIC_API_KEY = "stand-in";
process.env.ANTHROPIC_API_URL = "https://model.stand-in.test/v1/messages";
process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
process.env.ANTHROPIC_GAP_MODEL = "claude-haiku-4-5-20251001";
process.env.TYPESAFE_API_KEY = "";
const { runTurn } = await import("../src/lib/engine.ts");
const { finishTurn, turnContext } = await import("../src/lib/turn-run.ts");
const { answerFor } = await import("../src/lib/client-turn.ts");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const RETURNS = JSON.stringify({
  type: "blueprint",
  title: "Returns",
  message: "This would keep your returns, each with its reason.",
  blueprint: {
    summary: "A section for returns.",
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "returns", nav_label: "Returns", icon: "table" },
        newSchema: { columns: [{ field: "reason", label: "Reason", type: "text" }] },
        features: { view: { type: "table" } },
        newRecords: null,
        explanation: "Somewhere to keep each return and why it came back.",
      },
    ],
    workflow: [],
    unmet: [],
    next: [],
  },
});
const ASKS_BACK = JSON.stringify({
  type: "clarify",
  title: "Packing",
  message: "One thing first.",
  questions: [{ id: "q1", question: "Does the scanner read the SKU or the barcode?" }],
});

/** What the stood-in model says next, to the design call. */
let says = RETURNS;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const text = system.includes("name what they asked for that is missing") ? '{"unmet": []}' : says;
  return new Response(
    JSON.stringify({
      id: "msg_stand_in",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const ai = await signInAsClient(env, APP);
if (!ai.token) {
  console.log(`  FAIL  could not connect as a client — ${ai.why}`);
  process.exit(1);
}
const db = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${ai.token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, ai.userId, "client turn");
const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);

/** One ask, run and ended as propose_change runs it here (api/mcp runHere). */
async function ask(request, conversation = null, beforeEnd = async () => {}) {
  const { data: o, error } = await db.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: request,
    p_conversation: conversation,
  });
  if (error) throw new Error(error.message);
  const { data: proj } = await db.from("projects").select("*").eq("id", project.id).single();
  const job = {
    userId: ai.userId,
    projectId: project.id,
    moduleId: null,
    conversationId: o.conversation_id,
    askedId: o.asked_id,
    answerId: o.answer_id,
    message: request,
    askedModel: null,
    askedAt: Date.parse(o.asked_at),
    isNewConversation: o.new,
    client: { origin: APP },
  };
  const ctx = await turnContext(db, proj, {
    projectId: project.id,
    moduleId: null,
    conversationId: o.conversation_id,
    before: new Date(job.askedAt).toISOString(),
  });
  const turn = await runTurn({
    client: db,
    project: proj,
    modules: ctx.moduleList,
    message: request,
    history: ctx.history,
    currentSchema: ctx.currentSchema,
    currentFeatures: ctx.currentFeatures,
    blueprintShown: ctx.blueprintShown,
    plansAllowed: true,
  });
  await beforeEnd(o);
  const later = [];
  const done = await finishTurn(db, job, ctx, turn, null, [], (fn) => later.push(fn));
  await Promise.all(later.map((fn) => fn().catch(() => {})));
  const { data: line } = await admin.from("messages").select("payload, content").eq("id", o.answer_id).single();
  const said = JSON.parse(done.last?.content?.[0]?.text ?? "{}");
  return { o, done, line: line?.payload, content: line?.content, said };
}

try {
  console.log("a design, built as it arrives when the merchant said it may be");
  await setAuto(true);
  says = RETURNS;
  const built = await ask("Make a returns section with a reason for each return");
  check(
    "the assistant is told it was built, and where to carry on",
    built.said.status === "built" && built.said.conversation_id === built.o.conversation_id
  );
  check(
    "the thread says what was built, in the build's own words",
    built.line?.type === "applied" && /Returns/.test(built.line?.message ?? "")
  );
  check(
    "and the assistant's answer is on the line, for when it asks again",
    JSON.stringify(answerFor(built.line, built.o.conversation_id)) === JSON.stringify(built.line?.mcp)
  );
  const { data: req } = await admin
    .from("build_requests")
    .select("status, auto_built, client_id")
    .eq("id", built.line?.request_id)
    .single();
  check(
    "it is a request like any other, built by nobody's tap",
    req?.status === "built" && req?.auto_built === true && req?.client_id === ai.clientId
  );
  check("and the charge is kept: a request was written down", built.done.charged === true);
  const { data: mods } = await admin.from("modules").select("nav_label").eq("project_id", project.id);
  check(
    "the section is there",
    (mods ?? []).some((m) => m.nav_label === "Returns")
  );
  const { data: elsewhere } = await admin
    .from("conversations")
    .select("id")
    .eq("project_id", project.id)
    .eq("title", "Changes from your AI");
  check('and it is told in its own thread, not again in "Changes from your AI"', (elsewhere ?? []).length === 0);

  console.log("\na design that waits, when they did not");
  await setAuto(false);
  says = RETURNS.replaceAll("returns", "refunds").replaceAll("Returns", "Refunds");
  const waits = await ask("Make a refunds section with a reason for each refund");
  check(
    "the assistant is told it waits for approval",
    waits.said.status === "waiting for approval" && !!waits.said.request_id
  );
  check(
    "the thread says so, and where",
    waits.line?.type === "answer" && /waits for your yes/.test(waits.line?.message ?? "")
  );
  const { data: pending } = await admin
    .from("build_requests")
    .select("status")
    .eq("id", waits.line?.request_id)
    .single();
  check("and the request waits", pending?.status === "pending");

  console.log("\na question back, and its answer in the same thread");
  says = ASKS_BACK;
  const asked = await ask("A packing screen for the courier desk");
  check(
    "the assistant is told what to ask",
    asked.said.status === "needs answers" && asked.said.questions?.length === 1
  );
  check(
    "the merchant sees the question in the thread",
    asked.line?.type === "clarify" && asked.line?.questions?.length === 1
  );
  check("and asking back costs nothing", asked.done.charged === false);
  says = RETURNS.replaceAll("returns", "packs").replaceAll("Returns", "Packs");
  const answered = await ask("It reads the barcode.", asked.o.conversation_id);
  check("the answer carries on in the same thread", answered.o.conversation_id === asked.o.conversation_id);
  check("and ends in its design", answered.said.status === "waiting for approval");

  console.log("\na stop in Warmluke is honoured");
  says = RETURNS.replaceAll("returns", "claims").replaceAll("Returns", "Claims");
  const stopped = await ask("Make a claims section", null, (o) =>
    admin
      .from("messages")
      .update({ payload: { type: "stopped" } })
      .eq("id", o.answer_id)
  );
  check("the assistant is told it was stopped", stopped.said.status === "stopped");
  const { count } = await admin
    .from("build_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .ilike("request", "%claims%");
  check("nothing is requested", count === 0);
  check("and nothing is charged", stopped.done.charged === false);
} finally {
  await project.remove();
  await ai.revoke().catch(() => {});
  await admin.auth.admin.oauth.deleteClient(ai.clientId).catch(() => {});
}

console.log(
  fails.length === 0 ? "\nan ask is answered in its own thread, however it ends" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
