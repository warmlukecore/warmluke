// A question answered in prose is the answer, not a reply to repair.
//
// On 2 October "hows my store doing since the past 15 days" cost $0.25:
// "hows" was not read as a question, so the turn took the design road,
// planner and all, and its reply, written in Markdown rather than as
// JSON, was sent back whole to be done again. Now the road reads
// questions as people type them (intent.ts), and a question answered
// in prose takes the prose. A request to build still gets its repair:
// prose there is not a design.
//
// The model is stood in for; nothing is taped or paid.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-prose-answer.mjs
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
for (const k of ["ANTHROPIC_PLAN_MODEL", "ANTHROPIC_CRITIC_MODEL", "ANTHROPIC_MEMORY_MODEL", "ANTHROPIC_TALK_MODEL"])
  delete process.env[k];
process.env.ANTHROPIC_API_KEY = "stand-in";
process.env.ANTHROPIC_API_URL = "https://model.stand-in.test/v1/messages";
process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
process.env.ANTHROPIC_GAP_MODEL = "claude-haiku-4-5-20251001";
process.env.TYPESAFE_API_KEY = "";
const { runTurn } = await import("../src/lib/engine.ts");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const PROSE = "## Over the last 15 days\n\n- **483 orders**, ₹4,17,158 in all\n- 60% still awaiting COD";
const SOUND = JSON.stringify({
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

// The stand-in answers in prose first, then, if sent back, as it was asked.
let asked = 0;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const text = system.includes("name what they asked for that is missing")
    ? '{"unmet": []}'
    : (asked++, asked === 1 ? PROSE : SOUND);
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
const project = await throwawayProject(admin, me.user.id, "prose answer");

try {
  const { data: proj } = await client.from("projects").select("*").eq("id", project.id).single();
  const turn = (message) => runTurn({ client, project: proj, modules: [], message });

  console.log("a question answered in prose");
  asked = 0;
  const q = await turn("hows my store doing since the past 15 days");
  check("is the answer", q.ok && q.reply.type === "answer" && q.reply.message === PROSE);
  check("asked once, with nothing sent back", asked === 1 && q.ok && q.repairs === 0);
  check("on the talk road", q.ok && q.road === "talk");

  console.log("\na request to build answered in prose");
  asked = 0;
  const b = await turn("Make a returns section with a reason for each return");
  check("is sent back for its design", b.ok && b.reply.type === "blueprint" && b.repairs === 1);
} finally {
  globalThis.fetch = real;
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\na question answered in prose is the answer");
process.exit(fails.length ? 1 : 0);
