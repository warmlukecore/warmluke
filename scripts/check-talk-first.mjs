// A design is said in words first, and built on a yes (Tanish, 3 Oct:
// "propose a plan in plain English … then ask: do you want me to build
// it? The user says yes, then it builds it").
//
// In the app's own chat, a request to build gets the plan step's words,
// ending "Want me to build it?", and nothing is drawn or charged. Their
// yes builds exactly what was said, marked agreed so the chat builds it
// without asking again; anything else they say plans again; "just build
// it" skips the talk. An outside assistant, with its own approval, never
// gets a plan in words. The model is stood in for: nothing is taped or paid.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-talk-first.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
delete process.env.MODEL_TAPE;
for (const k of ["ANTHROPIC_CRITIC_MODEL", "ANTHROPIC_MEMORY_MODEL", "ANTHROPIC_TALK_MODEL"]) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "stand-in";
process.env.ANTHROPIC_API_URL = "https://model.stand-in.test/v1/messages";
process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
process.env.ANTHROPIC_PLAN_MODEL = "claude-sonnet-5";
process.env.ANTHROPIC_GAP_MODEL = "claude-haiku-4-5-20251001";
process.env.TYPESAFE_API_KEY = "";
const { runTurn } = await import("../src/lib/engine.ts");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const SAY =
  "Each return gets a tick for RTO, and a count of them above the list. Should a return nobody marked count as not RTO? Want me to build it?";
const PLAN = JSON.stringify({
  goal: "Mark returns that came back RTO",
  rows: "a returns list of their own",
  work: ["tick RTO on a return"],
  facts: ["whether it is RTO"],
  rules: [],
  screens: ["a count of RTO returns above the list"],
  unsure: ["Does an unmarked return count as not RTO?"],
  say: SAY,
});
const DESIGN = JSON.stringify({
  type: "blueprint",
  title: "Returns",
  message: "A returns list with a tick for RTO.",
  blueprint: {
    summary: "A section for returns, each with an RTO tick.",
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "returns", nav_label: "Returns", icon: "table" },
        newSchema: { columns: [{ field: "rto", label: "RTO", type: "boolean" }] },
        features: { view: { type: "table" } },
        newRecords: null,
        explanation: "Somewhere to keep each return and whether it came back.",
      },
    ],
    workflow: [],
    unmet: [],
    next: [],
  },
});

// The stand-in answers each job by what its instructions say it is.
let calls = [];
let sent = [];
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const job = system.includes("You are not designing yet")
    ? "plan"
    : system.includes("You check a design against")
      ? "critic"
      : system.includes("name what they asked for that is missing")
        ? "gap"
        : "design";
  calls.push(job);
  sent.push({ job, text: JSON.stringify(body.messages ?? []) });
  const text =
    job === "plan" ? PLAN : job === "critic" ? '{"unmet": [], "redo": null}' : job === "gap" ? '{"unmet": []}' : DESIGN;
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
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const client = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "talk first");

try {
  const { data: proj } = await client.from("projects").select("*").eq("id", project.id).single();
  const turn = (message, history = [], lookups = true) => {
    calls = [];
    sent = [];
    return runTurn({ client, project: proj, modules: [], message, history, lookups });
  };
  const ASK = "Make me a returns section where I can mark which ones came back RTO";

  console.log("asked to build: the plan in words, and nothing drawn");
  const first = await turn(ASK);
  check(
    "its words are the plan's, ending with the question",
    first.ok && first.reply.type === "answer" && first.reply.message === SAY
  );
  check(
    "said as a plan to agree to, with Build it to tap",
    first.ok && first.reply.kind === "proposal" && first.reply.next?.[0]?.prompt === "Build it"
  );
  check("one small call: the design waits", calls.join() === "plan");
  const thread = [
    { role: "user", content: ASK },
    { role: "assistant", content: first.ok ? first.raw : "" },
  ];

  console.log("\ntheir yes builds what was said");
  const yes = await turn("haan bana do", thread);
  check("a design, built from what they agreed to", yes.ok && yes.reply.type === "blueprint");
  check("no second plan: what they read is the plan", !calls.includes("plan") && calls[0] === "design");
  check(
    "the design is told it was agreed, and not to ask again",
    !!sent.find((s) => s.job === "design")?.text.includes("WHAT THE OWNER AGREED TO")
  );
  check("and it is marked agreed, so the chat builds it", yes.ok && yes.reply.approved === true);

  console.log("\nanything else they say plans again");
  const more = await turn("unmarked means not RTO, and keep a note for each", thread);
  check("a new plan in words, not a design", more.ok && more.reply.kind === "proposal" && calls.join() === "plan");
  const why = await turn("why do I need a count?", thread);
  check("a question about it is answered, not planned", why.ok && why.reply.kind !== "proposal");

  console.log("\nasked to just build it");
  const now = await turn(`${ASK}, just build it`);
  check(
    "no talk: designed at once, and marked agreed",
    now.ok && now.reply.type === "blueprint" && now.reply.approved === true
  );

  console.log("\nan outside assistant has its own approval");
  const outside = await turn(ASK, [], false);
  check(
    "never a plan in words, and never marked agreed",
    outside.ok && outside.reply.kind !== "proposal" && !outside.reply.approved
  );
} finally {
  globalThis.fetch = real;
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\na design is talked through, then built on a yes");
process.exit(fails.length ? 1 : 0);
