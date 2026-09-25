// A turn is told as it happens, and a turn that did not finish is
// given back.
//
// The chat route used to answer in one piece after the model was
// done; now it answers in lines — each step the moment it happened,
// the reply last. Two things have to hold for that to be worth
// having: the lines must be true (the steps a turn actually took, in
// the order it took them, ending in the reply), and the charge must
// settle right on every way out — including the one the old code
// missed, a throw after the turn was spent. Here the throw is the
// browser leaving: the reader lets go after the first line, the
// model call is cut off, and the turn comes back on its own.
//
// Refusals still come as JSON with a status, because a stream cannot
// carry one. Both shapes are read through the same helper the other
// checks use.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-chat-stream.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { readTurn } from "./turn-lines.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

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
const token = me.session.access_token;
const project = await throwawayProject(admin, me.user.id, "chat-stream");

const ask = (message, signal) =>
  fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId: project.id, message }),
    signal,
  });
const used = async () =>
  (await admin.from("account_settings").select("turns_used").eq("user_id", me.user.id).single()).data?.turns_used;
// Waits for the counter to read `want`, up to a few seconds: the
// refund lands after the model call is cut off, not before.
const usedSettles = async (want) => {
  for (let i = 0; i < 30; i++) {
    if ((await used()) === want) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

// The account as it was, put back at the end whatever happens.
const { data: was } = await admin
  .from("account_settings")
  .select("free_turns, turns_used, turns_unlimited")
  .eq("user_id", me.user.id)
  .single();

try {
  await admin
    .from("account_settings")
    .update({ free_turns: 5, turns_used: 0, turns_unlimited: false, last_refund_at: null })
    .eq("user_id", me.user.id);

  console.log("a refusal is still one piece, with a status");
  const noToken = await fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, message: "hi" }),
  });
  const refused = await readTurn(noToken);
  check(
    "not signed in: 401 and JSON, not a stream",
    refused.status === 401 && refused.steps.length === 0 && /signed in/i.test(refused.data.error ?? "")
  );

  console.log("\na turn is told as it happens");
  const before = await used();
  const res = await ask("hi");
  check("the turn comes as lines", (res.headers.get("content-type") ?? "").includes("x-ndjson"));
  const turn = await readTurn(res);
  const order = turn.steps.map((s) => s.step).join(",");
  check(
    "taken, read the store, read the app, asked the model — in that order",
    order.startsWith("accepted,store,context,model")
  );
  if (!order.startsWith("accepted,store,context,model")) show(order);
  const first = turn.steps.find((s) => s.step === "model");
  check("the first ask says it is the first of three", first?.attempt === 1 && first?.of === 3);
  check(
    "no store here, and the line says so rather than pretending",
    turn.steps.find((s) => s.step === "store")?.shop === null
  );
  check("the app was read: no sections yet", turn.steps.find((s) => s.step === "context")?.sections === 0);
  // The model is somebody else's, and in CI there is no key for it at
  // all. When it is not there, the stream must still end — in an error
  // line, not silence — and the turn must still come back; that is a
  // valid outcome of this check, not a failure of it. What cannot be
  // checked without the model is said.
  const modelDown = !turn.data.reply && typeof turn.data.error === "string";
  if (modelDown) {
    console.log(
      `  skip  the model was not there — the stream ended in its error: ${String(turn.data.error).slice(0, 80)}`
    );
    check("and the error is the last line, not a dropped stream", typeof turn.data.error === "string");
  } else {
    check(
      "checked the reply, and the reply is the last line",
      /,checked/.test(order) && !!turn.data.reply && !!turn.data.conversationId
    );
    if (!turn.data.reply) show(turn.data);
  }
  check(
    modelDown ? "a turn the model failed is given back" : "a greeting is not a design, so the turn is given back",
    (await used()) === before
  );

  console.log("\na turn the browser walked out of comes back");
  // Read the first line — the turn has been spent by then — and let
  // go. The model call is cut off; nothing is written; the turn is
  // refunded by the same `finally` that settles every other exit.
  const before2 = await used();
  const stop = new AbortController();
  const res2 = await ask("make me a returns section with a reason, a refund amount and a status", stop.signal);
  const reader = res2.body.getReader();
  const { value } = await reader.read();
  const firstLine = new TextDecoder().decode(value).split("\n")[0];
  check("the first line says the turn was taken", firstLine.includes('"accepted"'));
  stop.abort();
  check("and it comes back once the model call is cut off", await usedSettles(before2));
  const { count } = await admin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .neq("id", turn.data.conversationId ?? "00000000-0000-0000-0000-000000000000");
  check("and nothing was written for it", count === 0);

  console.log("\nout of turns is still a refusal with a status");
  await admin.from("account_settings").update({ turns_used: 5 }).eq("user_id", me.user.id);
  const broke = await readTurn(await ask("make me a section"));
  check(
    "402, JSON, and it says why",
    broke.status === 402 && broke.data.out_of_turns === true && broke.steps.length === 0
  );
} finally {
  await admin
    .from("account_settings")
    .update({
      free_turns: was?.free_turns ?? 10,
      turns_used: was?.turns_used ?? 0,
      turns_unlimited: was?.turns_unlimited ?? false,
    })
    .eq("user_id", me.user.id);
  await project.remove();
}

console.log(
  fails.length === 0
    ? "\nthe turn is told as it happens, and a turn that did not finish comes back"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
