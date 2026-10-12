// A whole Luke turn as an agent (LUKE_AGENT=on), on the check project, with
// the model stood in: the engine, the real design check, the gates and the
// card are all real; only the model's words are scripted, and nothing is
// taped or paid.
//
// Holds that a change the real validator refuses is said back to Luke in
// its words and never reaches the owner; that the turn ends in the card the
// app always showed (a new section waits for a yes as a blueprint); that
// what was refused is kept on the receipt; and that with the switch off the
// same ask takes the old road and never sees the agent's tools.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-agent-turn.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
// The model, stood in for, at an address of its own; nothing is taped.
delete process.env.MODEL_TAPE;
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_.*_MODEL$/.test(k)) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "stand-in";
process.env.ANTHROPIC_API_URL = "https://model.stand-in.test/v1/messages";
process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
process.env.ANTHROPIC_GAP_MODEL = "claude-haiku-4-5-20251001";
process.env.TYPESAFE_API_KEY = "";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The agent's turns, scripted; the gap pass answered as nothing missing; anything else is a plain JSON answer.
const script = [];
const sent = [];
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  sent.push({ agent: system.includes("HOW YOU WORK"), body });
  let content;
  if (system.includes("name what they asked for that is missing")) content = [{ type: "text", text: '{"unmet": []}' }];
  else if (system.includes("HOW YOU WORK")) {
    const next = script.shift() ?? { tool: "finish", input: { message: "Done." } };
    content = [{ type: "tool_use", id: `toolu_${sent.length}`, name: next.tool, input: next.input }];
  } else
    content = [
      {
        type: "text",
        text: JSON.stringify({ type: "answer", kind: "conversation", title: "Hi", message: "Old road." }),
      },
    ];
  return new Response(
    JSON.stringify({
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

const { runTurn } = await import("../src/lib/engine.ts");
const { applyPlans } = await import("../src/lib/apply.ts");
const { testAfterBuild } = await import("../src/lib/verify.ts");
const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now();
const email = `agent_turn_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const owner = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await owner.auth.signInWithPassword({ email, password });
const { data: project } = await admin
  .from("projects")
  .insert({ owner_id: made.user.id, name: `check agent turn ${stamp}` })
  .select("*")
  .single();

const REPAIRS = {
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: { name: "repairs", nav_label: "Repairs", icon: "table", parent_id: null, source_table: null },
  newSchema: {
    columns: [
      { field: "customer", label: "Customer", type: "text" },
      { field: "stage", label: "Stage", type: "badge" },
    ],
  },
  features: { view: { type: "board", groupBy: "stage", cardTitle: "customer" } },
  newRecords: [
    { customer: "Asha", stage: "Intake" },
    { customer: "Ravi", stage: "Done" },
  ],
  explanation: "A board of repairs by stage.",
};
const turn = (message) => runTurn({ client: owner, project, modules: [], message, history: [], lookups: true });

try {
  console.log("a turn as an agent, through the real design check");
  process.env.LUKE_AGENT = "on";
  script.push(
    { tool: "guide", input: { topics: ["plan", "views"] } },
    // A board grouped by a field the section does not have: the validator's to refuse.
    {
      tool: "draft_change",
      input: {
        change: { ...REPAIRS, features: { view: { type: "board", groupBy: "status", cardTitle: "customer" } } },
      },
    },
    { tool: "draft_change", input: { change: REPAIRS } },
    {
      tool: "finish",
      input: { title: "Repairs board", message: "This would put every repair on a board by its stage." },
    }
  );
  // "just build it": new work drafted with no plan said first only when they ask for that (12 Oct).
  const out = await turn("I lose track of repairs. Make me a board of them by stage, just build it.");
  const agentCalls = sent.filter((s) => s.agent);
  check("the turn was the agent's", agentCalls.length === 4);
  const offered = (agentCalls[0]?.body.tools ?? []).map((t) => t.name);
  check(
    "with every door the owner has: reads, asks to change rows, and the test of what is built",
    ["read_section", "rule_runs", "change_rows", "whats_waiting", "test_build", "draft_change", "test_draft"].every(
      (n) => offered.includes(n)
    )
  );
  // Asked to just build it: the card to apply, with nothing left to agree to first.
  check("it ends in the card the app always showed", out.ok && out.reply.type === "plans");
  const plans = out.ok ? (out.reply.blueprint?.plans ?? out.reply.plans ?? []) : [];
  check("holding the section Luke drafted, as drafted", plans.length === 1 && plans[0].newModule?.name === "repairs");
  const third = JSON.stringify(agentCalls[2]?.body.messages ?? []);
  check(
    "the refused change was said back to Luke in the validator's words",
    /groupBy|status/.test(third) && third.includes("Nothing changed in the design")
  );
  check(
    "and is on the receipt, never in the design",
    out.ok && out.repairErrors.length > 0 && plans.every((p) => p.features?.view?.groupBy === "stage")
  );
  check(
    "the agent's words, not a form's, are the message",
    out.ok && /board by its stage/.test(out.reply.message ?? "")
  );

  console.log("\nonce built, tried on their data and said on the build's line");
  const { applied, errors } = await applyPlans(owner, project.id, plans, null, "ai");
  check("the design builds", applied.length === 1 && errors.length === 0);
  const { data: convo } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "check" })
    .select("id")
    .single();
  const { data: line } = await admin
    .from("messages")
    .insert({
      conversation_id: convo.id,
      role: "assistant",
      content: "Built.",
      payload: { type: "applied", message: "Repairs." },
    })
    .select("id")
    .single();
  await testAfterBuild(owner, project.id, line.id);
  const { data: after } = await admin.from("messages").select("payload").eq("id", line.id).single();
  check(
    "the test's words are on the line, beside what was there",
    typeof after.payload?.tested?.said === "string" &&
      after.payload.tested.said.length > 0 &&
      after.payload.message === "Repairs."
  );
  check(
    "with whether it works as tried",
    typeof after.payload?.tested?.ok === "boolean" && Array.isArray(after.payload.tested.problems)
  );

  console.log("\nwith the switch off, the old road");
  delete process.env.LUKE_AGENT;
  sent.length = 0;
  const old = await turn("Hi Luke");
  check("answers as it always did", old.ok && old.reply.type === "answer" && old.reply.message === "Old road.");
  check(
    "never seeing the agent's contract or tools",
    sent.every((s) => !s.agent && !(s.body.tools ?? []).some((t) => t.name === "draft_change"))
  );
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  await admin.auth.admin.deleteUser(made.user.id);
}

console.log(
  fails.length === 0
    ? "\na turn built a change at a time, ending in the card it always did"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
