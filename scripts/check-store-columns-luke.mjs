// Luke is shown the store's lists as the account is (0192): with Orders
// narrowed to four columns, nothing Luke reads in a turn names the others
// (the brief, the field-by-field store, the sections), and he is told some
// are not shown, to say so rather than guess. The same turn with every
// column names them, so the narrowing is what took them out. The model is
// stood in for; nothing is taped or paid.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-columns-luke.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") throw new Error("not the check project's env; this writes");
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

// Every request the model would have read, kept; each answered with a plain answer.
let sent = "";
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("model.stand-in.test")) return real(input, init);
  const body = JSON.parse(init.body);
  sent += JSON.stringify(body.system ?? "") + JSON.stringify(body.messages ?? "");
  const gap = JSON.stringify(body.system ?? "").includes("name what they asked for that is missing");
  const text = gap ? '{"unmet": []}' : JSON.stringify({ type: "answer", title: "Orders", message: "Here they are." });
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
const project = await throwawayProject(admin, me.user.id, "store columns luke");
const SHOWN = ["order_number", "placed_at", "total", "status"];
// Columns only Orders has (a payment's own gateway is Transactions', not narrowed):
// never in a request when Orders is narrowed, its advice included.
const HIDDEN = ["customer_phone", "ship_city", "discount_codes", "total_original", "subtotal"];
const ASK = "Make a section over my orders to pack them, with a packed tick";

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `columns-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const { data: proj } = await client.from("projects").select("*").eq("id", project.id).single();
  const turn = () => runTurn({ client, project: proj, modules: [], message: ASK });

  console.log("every column");
  sent = "";
  await turn();
  check(
    "a turn reads the orders' columns",
    HIDDEN.every((f) => sent.includes(f))
  );
  check("and is told nothing is narrowed", !sent.includes("only some of the store's columns"));

  console.log("\nOrders narrowed to four columns");
  const { error: setErr } = await admin
    .from("account_store_columns")
    .insert({ user_id: me.user.id, store_table: "orders", shown: SHOWN });
  if (setErr) throw new Error(`could not narrow: ${setErr.message}`);
  sent = "";
  await turn();
  const named = HIDDEN.filter((f) => sent.includes(f));
  if (named.length) console.log("    named:", named.join(", "));
  if (process.env.SHOW_WHERE)
    for (const f of named)
      for (const m of sent.matchAll(new RegExp(`.{0,140}${f}.{0,80}`, "g"))) console.log(`    [${f}]`, m[0]);
  check("no request names a column it is not shown", named.length === 0);
  check(
    "the ones it is shown are still there",
    SHOWN.every((f) => sent.includes(f))
  );
  check("and Luke is told some are not shown", sent.includes("only some of the store's columns on: orders"));
} finally {
  globalThis.fetch = real;
  await admin.from("account_store_columns").delete().eq("user_id", me.user.id);
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nLuke reads the store as the account is shown it");
process.exit(fails.length ? 1 : 0);
