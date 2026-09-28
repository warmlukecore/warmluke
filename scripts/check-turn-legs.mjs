// A turn run in legs is the same turn (engine.ts TurnState, the durable
// turn's legs in workflows/luke-turn.ts).
//
// The model is stood in for: its first design is refused by the
// validator, its second is sound. The turn is run once straight through,
// then again stopped after its first attempt — its state through JSON,
// as a workflow hands it between steps — and carried on in a second
// leg. Both must end in the same design, and the repair the second leg
// sends must be word for word the one the straight run sent: a leg goes
// on from where the last stopped, and asks nothing twice.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-turn-legs.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

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

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const blueprint = (view) =>
  JSON.stringify({
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
          features: { view },
          newRecords: null,
          explanation: "Somewhere to keep each return and why it came back.",
        },
      ],
      workflow: [],
      unmet: [],
      next: [],
    },
  });
// Grouped by a field that is not there: the validator sends it back.
const REFUSED = blueprint({ type: "board", groupBy: "stage", cardTitle: "reason" });
const SOUND = blueprint({ type: "table" });

let designs = [];
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const text = system.includes("name what they asked for that is missing")
    ? '{"unmet": []}'
    : (designs.push(body.messages), designs.length === 1 ? REFUSED : SOUND);
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
const project = await throwawayProject(admin, me.user.id, "turn legs");

try {
  const { data: proj } = await client.from("projects").select("*").eq("id", project.id).single();
  const turn = (more) =>
    runTurn({
      client,
      project: proj,
      modules: [],
      message: "Make a returns section with a reason for each return",
      ...more,
    });

  console.log("straight through");
  designs = [];
  const whole = await turn({});
  const straight = designs;
  check("the refused design is repaired, and the turn ends in the sound one", whole.ok && whole.repairs === 1);
  check("two designs asked for", straight.length === 2);

  console.log("\nstopped after its first attempt, and carried on");
  designs = [];
  const first = await turn({ deadline: Date.now() });
  const paused = !first.ok ? first.paused : undefined;
  check("the first leg stops before a second attempt it has no time for", !!paused && paused.attempt === 1);
  check("having asked once", designs.length === 1);
  // As a workflow hands it on: through JSON.
  const handed = JSON.parse(JSON.stringify(paused ?? null));
  const second = await turn({ deadline: Date.now() + 600_000, resume: handed });
  const legs = designs;
  check("the second leg ends the turn", second.ok);
  check("in the same design", second.ok && whole.ok && JSON.stringify(second.reply) === JSON.stringify(whole.reply));
  check(
    "the repair it sends is word for word the straight run's",
    JSON.stringify(legs[1]) === JSON.stringify(straight[1])
  );
  check("and it asks for nothing twice: two designs across both legs", legs.length === 2);
  check("with the repair counted once", second.ok && second.repairs === 1);
} finally {
  globalThis.fetch = real;
  await project.remove();
}

console.log(fails.length === 0 ? "\na turn in legs is the same turn" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
