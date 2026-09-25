// Luke looks up what the snapshot does not hold, and says what it read.
//
// A throwaway store with twenty-five orders: the snapshot Luke is handed
// shows the latest twenty, so the oldest, #1001, is out of its sight. It
// is unpaid, for 777, so an answer that has those facts right read them
// rather than guessing.
//
// Through the chat route, the question router usually brings #1001 in
// itself, so the turn only has to be right, and any lookup it made must
// be on the receipt. The tool loop is then proven on its own: the same
// engine with the router off (no Jev key in this process), where only a
// lookup can find #1001. And a question the snapshot answers must not
// spend a lookup at all.
//
// Then a change to the shop: with the account's switch on, "tag #1003
// VIP" must become one request waiting for the merchant, aimed at that
// order's Shopify id, worded by the server, and never run; with it off,
// the same words ask for nothing. The switch is put back as it was.
//
// Model settings (keys, names) come from MODEL_ENV_FILE, .env.local by
// default, the file the dev server reads them from; nothing else in it
// is used.
//
// Recorded against real models by hand, and played back everywhere else
// (model-tape.ts): the server and this process both need the same mode.
//   record:  MODEL_TAPE=record, on the dev server and here, with keys
//   replay:  MODEL_TAPE=replay, on both, no keys, no network
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-luke-lookups.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { runTurn } from "../src/lib/engine.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
// Played back unless asked to record: free, and the same every run.
process.env.MODEL_TAPE ??= "replay";
for (const l of readFileSync(new URL(`../${process.env.MODEL_ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8").split("\n")) {
  const m = l.match(/^(ANTHROPIC_[A-Z_]+|GEMINI_API_KEY)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
// Set and empty, not deleted: the router is off here, and while replaying a
// missing key would be a stand-in and the router on.
process.env.TYPESAFE_API_KEY = "";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 300));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "luke-lookups");
const stamp = Date.now().toString(36);
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** One chat turn, as the panel sends it: the steps it told, and the reply. */
async function ask(message) {
  const res = await fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${me.session.access_token}` },
    body: JSON.stringify({ message, projectId: project.id }),
  });
  // The server has to be doing what this process is doing: recording
  // with it, or playing back with it. A server making real calls under a
  // check that plays back would bill for every turn and answer anything.
  // Only an answer says how it was made: a refusal before the model (out
  // of turns, over the hour's limit) never called one, and is shown as
  // itself below rather than blamed on the server's mode.
  const serverTape = res.headers.get("x-model-tape");
  if (res.ok && serverTape !== process.env.MODEL_TAPE) {
    throw new Error(
      `the server at ${APP} is ${serverTape ? `in ${serverTape} mode` : "making real model calls"}, and this check is in ${process.env.MODEL_TAPE} mode; start it with MODEL_TAPE=${process.env.MODEL_TAPE}`
    );
  }
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    status: res.status,
    lines,
    steps: lines.filter((l) => "step" in l),
    words: lines.filter((l) => "words" in l).map((l) => l.words),
    last: lines.filter((l) => !("step" in l) && !("words" in l)).at(-1) ?? {},
  };
}

try {
  const store = must(
    await admin
      .from("stores")
      .insert({ project_id: project.id, shop_domain: `luke-${stamp}.myshopify.com`, status: "connected", currency: "INR", timezone: "Asia/Kolkata", granted_scopes: ["read_orders", "write_orders", "read_products", "write_products", "read_customers", "write_customers"] })
      .select("id")
      .single()
  );
  // #1001 is the oldest, 30 days back; #1025 was placed today.
  must(
    await admin.from("orders").insert(
      Array.from({ length: 25 }, (_, i) => {
        const n = 1001 + i;
        return {
          store_id: store.id,
          // Fixed, not from the stamp: a replayed answer names the id it was
          // recorded with, and it has to be this run's order too.
          external_id: `gid://shopify/Order/${9000000 + n}`,
          order_number: `#${n}`,
          placed_at: daysAgo(30 - i),
          total: n === 1001 ? 777 : 100 + i,
          currency: "INR",
          financial_status: n === 1001 ? "PENDING" : "PAID",
          tags: [],
        };
      })
    )
  );

  const unpaid = (text) => /777/.test(text ?? "") && /(not|un)\s*paid|pending|awaiting|due/i.test(text ?? "");

  console.log("an order the snapshot does not show, through the chat");
  const out = await ask("Is order #1001 paid? How much was it?");
  const reply = out.last.reply;
  check("the turn answers", out.status === 200 && reply?.type === "answer");
  if (reply?.type !== "answer") show(out.last);
  check("with the facts right: 777, and not paid", unpaid(reply?.message));
  if (reply) show(reply.message);
  const told = out.steps.filter((s) => s.step === "lookup").map((s) => s.about);
  check("and every lookup it told is on the receipt", JSON.stringify(reply?.grounding?.looked_up ?? []) === JSON.stringify(told));
  const drafts = out.words.filter(Boolean);
  check("its words arrived as they were written", drafts.length >= 1);
  check("growing toward the reply, and ending as its message", !!reply?.message && drafts.every((d) => reply.message.startsWith(d.trimEnd()) || d === reply.message) && (drafts.at(-1) === reply.message || reply.message.startsWith(drafts.at(-1))));
  if (drafts.length) show(drafts.slice(-3));
  check("and nothing came after the reply", "reply" in (out.lines.at(-1) ?? {}));

  console.log("\nthe same, with the router off: only a lookup can find it");
  const { data: row } = await client.from("projects").select("*").eq("id", project.id).single();
  const steps = [];
  const turn = await runTurn({
    client,
    project: row,
    modules: [],
    message: "Is order #1001 paid? How much was it?",
    lookups: true,
    onEvent: (e) => steps.push(e),
  });
  check("no rows for #1001 were routed in", !steps.find((e) => e.step === "store")?.read);
  check("the turn answers", turn.ok && turn.reply.type === "answer");
  check("by looking the order up, and saying so as it happened", steps.some((e) => e.step === "lookup" && /1001/.test(e.about)));
  check("with the facts it read: 777, and not paid", turn.ok && unpaid(turn.reply.message));
  if (turn.ok) show(turn.reply.message);
  check("and the turn keeps what it looked up, for the receipt", turn.ok && turn.lookedUp.some((a) => /1001/.test(a)));
  if (!turn.ok) show(turn);

  console.log("\na question the snapshot already answers");
  const plain = await ask("What was my most recent order number?");
  check("is answered", plain.last.reply?.type === "answer" && /1025/.test(plain.last.reply?.message ?? ""));
  if (!/1025/.test(plain.last.reply?.message ?? "")) show(plain.last);
  check("without spending a lookup", !plain.steps.some((s) => s.step === "lookup"));
  if (plain.steps.some((s) => s.step === "lookup")) show(plain.steps.filter((s) => s.step === "lookup"));
  console.log("\na change to the shop, asked for");
  const { data: setting } = await admin.from("account_settings").select("store_actions_enabled").eq("user_id", me.user.id).maybeSingle();
  const was = setting?.store_actions_enabled ?? false;
  const setSwitch = async (on) =>
    must(await admin.from("account_settings").upsert({ user_id: me.user.id, store_actions_enabled: on }, { onConflict: "user_id" }).select("user_id"));
  const target = must(await admin.from("orders").select("external_id").eq("store_id", store.id).eq("order_number", "#1003").single()).external_id;
  try {
    await setSwitch(true);
    const change = await ask("Please add the tag VIP to order #1003.");
    const rows = must(await admin.from("store_actions").select("action, status, targets, params, summary, requested_by, client_id").eq("project_id", project.id));
    check("it becomes one request, waiting for the merchant", rows.length === 1 && rows[0].status === "pending");
    if (rows.length !== 1) show({ rows, steps: change.steps, last: change.last });
    const row = rows[0];
    check("to add the tag VIP, on #1003's own Shopify id", row?.action === "add_tags" && JSON.stringify(row?.params?.tags) === '["VIP"]' && row?.targets?.length === 1 && row.targets[0].id === target);
    check("asked as the merchant, not as an outside client", row?.requested_by === me.user.id && row?.client_id === null);
    check("the turn says it asked", change.steps.some((s) => s.step === "proposed" && s.summary === row?.summary));
    const said = change.last.reply?.message ?? "";
    check("and the reply says it is waiting for them, not done", /wait|approv|confirm|yes|agree/i.test(said) && !/\b(done|added|tagged)\b(?!.*(once|when|after))/i.test(said.replace(/will be (added|tagged)/gi, "")));
    show(said);

    await setSwitch(false);
    const before = rows.length;
    const refused = await ask("Please add the tag VIP to order #1004.");
    const after = must(await admin.from("store_actions").select("id").eq("project_id", project.id)).length;
    check("with the switch off, the same words ask for nothing", after === before && !refused.steps.some((s) => s.step === "proposed"));
  } finally {
    await setSwitch(was);
  }
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nLuke looks up what it cannot see, and only that" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
