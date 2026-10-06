// The repair loop tells the model the truth, and gives it what it needs
// (Carefone, 6 Oct). Three of the owner's turns failed for the loop's own
// reasons, not the model's:
//
//   - a reply with a bracket left open (~1,100 tokens) was told three times
//     it had run past the 12000-token cap, and to send it shorter;
//   - a whole, sound design was thrown away for words written after it;
//   - the repair of a design came back as "Here's the build:" with nothing
//     in it, and that was shown.
//
// Now: "ran out of room" only when the model said so, and the next try has
// more; a slip says which bracket; words around a whole reply are left;
// a dropped design is asked for once. The model is stood in for; nothing
// is taped or paid.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-repair-honest.mjs
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
for (const k of [
  "ANTHROPIC_PLAN_MODEL",
  "ANTHROPIC_CRITIC_MODEL",
  "ANTHROPIC_MEMORY_MODEL",
  "ANTHROPIC_TALK_MODEL",
  "ANTHROPIC_OPS_MODEL",
  "ANTHROPIC_REVIEW_MODEL",
  "ANTHROPIC_UX_MODEL",
  "ANTHROPIC_TRYOUT_MODEL",
  "ANTHROPIC_DESIGN_EFFORT",
])
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

const design = (extra = {}) => ({
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
        features: { view: { type: "table" }, ...extra },
        newRecords: null,
        explanation: "Somewhere to keep each return and why it came back.",
      },
    ],
    workflow: [],
    unmet: [],
    next: [],
  },
});
const SOUND = JSON.stringify(design());
// A board grouped by a field the section does not have: the validator's.
const WRONG = JSON.stringify({
  ...design(),
  blueprint: {
    ...design().blueprint,
    plans: [{ ...design().blueprint.plans[0], features: { view: { type: "board", groupBy: "stage" } } }],
  },
});

// What the stand-in says, in turn; and what it was sent, kept.
let script = [];
let sent = [];
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const gap = system.includes("name what they asked for that is missing");
  const next = gap ? { text: '{"unmet": []}' } : (script.shift() ?? { text: SOUND });
  if (!gap) sent.push(body);
  return new Response(
    JSON.stringify({
      id: "msg_stand_in",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: next.text }],
      stop_reason: next.stop ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
const lastUser = (body) =>
  JSON.stringify([...(body?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const client = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "repair honest");
const ASK = "Make a returns section with a reason for each return";

try {
  const { data: proj } = await client.from("projects").select("*").eq("id", project.id).single();
  const turn = () => runTurn({ client, project: proj, modules: [], message: ASK });

  console.log("a reply that truly ran out of room");
  sent = [];
  script = [{ text: SOUND.slice(0, 120), stop: "max_tokens" }, { text: SOUND }];
  let t = await turn();
  check("is built on the next try", t.ok && t.reply.type === "blueprint" && t.repairs === 1);
  check("which was given more room", sent[0]?.max_tokens === 12000 && sent[1]?.max_tokens === 32000);
  check(
    "and told it ran out, not to be shorter",
    /ran out of room/.test(lastUser(sent[1])) && !/shorter/.test(lastUser(sent[1]))
  );

  console.log("\na reply with a bracket left open, not out of room");
  sent = [];
  script = [{ text: SOUND.slice(0, -2) }, { text: SOUND }];
  t = await turn();
  check("is built on the next try", t.ok && t.reply.type === "blueprint" && t.repairs === 1);
  check(
    "told which bracket, never that it ran out of room",
    /brackets? open/.test(lastUser(sent[1])) && !/room|12000|cut off/.test(lastUser(sent[1]))
  );
  check("and not given more room it did not need", sent[1]?.max_tokens === 12000);

  console.log("\na whole design with words after it");
  sent = [];
  script = [{ text: `${SOUND}Add fields to Orders` }];
  t = await turn();
  check("is the design, with nothing sent back", t.ok && t.reply.type === "blueprint" && t.repairs === 0);

  console.log("\na repair that drops the design");
  sent = [];
  script = [
    { text: WRONG },
    { text: JSON.stringify({ type: "answer", title: "Returns", message: "Here's the build:" }) },
    { text: SOUND },
  ];
  t = await turn();
  check("is asked for the design once, and builds it", t.ok && t.reply.type === "blueprint" && t.repairs === 2);
  check("told it dropped the design", /answer with no design/.test(lastUser(sent[2])));
} finally {
  globalThis.fetch = real;
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nthe repair loop tells the model the truth");
process.exit(fails.length ? 1 : 0);
