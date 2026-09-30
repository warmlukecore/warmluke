// What the merchant's own AI asks for opens a conversation of its own in
// Luke's panel, and the only line it can fill there is its own answer
// (0139: abo_client_ask, abo_client_settle). No model: the doors alone.
//
// A client's token may not write conversations or messages (0028), so
// these two write for it, as the definer. What they must never become is
// a way round that wall: a design card slipped in front of the Build
// button, another assistant's line filled, the owner's own thread
// written in, or a stranger's app.
//
//   ENV_FILE=.env.check.local APP_URL=http://127.0.0.1:3101 node scripts/check-client-ask.mjs

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
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const as = (token) =>
  createClient(URL_, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const ai = await signInAsClient(env, APP);
const other = await signInAsClient(env, APP);
if (!ai.token || !other.token) {
  console.log(`  FAIL  could not connect as a client — ${ai.why ?? other.why}`);
  process.exit(1);
}
const A = as(ai.token);
const B = as(other.token);
const project = await throwawayProject(admin, ai.userId, "client-ask");
const stamp = Date.now();
const { data: stranger } = await admin.auth.admin.createUser({
  email: `client_ask_${stamp}@example.com`,
  password: `pw_${stamp}_aA1!`,
  email_confirm: true,
});
const theirs = await throwawayProject(admin, stranger.user.id, "client-ask stranger");

try {
  console.log("an ask opens a conversation of its own");
  const { data: opened, error: openErr } = await A.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "A packing screen for the courier desk",
  });
  check("it opens", !openErr && typeof opened?.conversation_id === "string");
  if (openErr) console.log("     →", openErr.message);
  const { data: conv } = await admin
    .from("conversations")
    .select("asked_by, asked_client, title")
    .eq("id", opened?.conversation_id)
    .single();
  check(
    "marked with the assistant that asked, by the name it registered",
    conv?.asked_client === ai.clientId && typeof conv?.asked_by === "string" && conv.asked_by.startsWith("check-")
  );
  const { data: lines } = await admin
    .from("messages")
    .select("id, role, payload")
    .eq("conversation_id", opened?.conversation_id)
    .order("created_at", { ascending: true });
  check(
    "the question, as asked through their AI, then a line for its answer",
    lines?.length === 2 &&
      lines[0].role === "user" &&
      lines[0].payload?.via === "client" &&
      lines[0].payload?.by === conv?.asked_by &&
      lines[1].id === opened?.answer_id &&
      lines[1].payload?.type === "answering"
  );

  console.log("\nits line holds an answer, never a design card");
  const forged = await A.rpc("abo_client_settle", {
    p_answer: opened.answer_id,
    p_payload: { type: "plans", plans: [] },
  });
  check("a design card cannot be written there", !!forged.error);
  const blueprint = await A.rpc("abo_client_settle", {
    p_answer: opened.answer_id,
    p_payload: { type: "blueprint", blueprint: { plans: [] } },
  });
  check("nor a blueprint", !!blueprint.error);
  const byOther = await B.rpc("abo_client_settle", {
    p_answer: opened.answer_id,
    p_payload: { type: "answer", message: "not mine" },
  });
  check("another assistant cannot fill it", byOther.data === false);
  const filled = await A.rpc("abo_client_settle", {
    p_answer: opened.answer_id,
    p_payload: { type: "clarify", message: "SKU or barcode?", questions: [] },
    p_content: '{"type":"clarify"}',
  });
  check("its own assistant fills it", filled.data === true);
  const again = await A.rpc("abo_client_settle", {
    p_answer: opened.answer_id,
    p_payload: { type: "answer", message: "twice" },
  });
  check("once", again.data === false);

  console.log("\nthe same words again are a retry, not a second design");
  const retried = await A.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "A packing screen for the courier desk",
  });
  check(
    "handed the ask it already made",
    !retried.error && retried.data?.again === true && retried.data?.answer_id === opened.answer_id
  );
  const { count: lineCount } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", opened.conversation_id);
  check("and nothing is added to its thread", lineCount === 2);
  const failedAsk = await A.rpc("abo_client_ask", { p_project: project.id, p_request: "A returns desk" });
  await A.rpc("abo_client_settle", {
    p_answer: failedAsk.data.answer_id,
    p_payload: { type: "unanswered", message: "Luke could not get this right." },
  });
  const afterFailure = await A.rpc("abo_client_ask", { p_project: project.id, p_request: "A returns desk" });
  check(
    "but one that failed is asked anew",
    !afterFailure.error && !afterFailure.data?.again && afterFailure.data?.answer_id !== failedAsk.data.answer_id
  );
  const fromOther = await B.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "A packing screen for the courier desk",
  });
  check("and another assistant's same words are its own ask", !fromOther.error && !fromOther.data?.again);

  console.log("\nit carries on in its own conversation, and no other");
  const more = await A.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "It scans the barcode",
    p_conversation: opened.conversation_id,
  });
  check(
    "with the merchant's answers, in the same conversation",
    !more.error && more.data?.conversation_id === opened.conversation_id && more.data?.new === false
  );
  const carried = await B.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "mine now",
    p_conversation: opened.conversation_id,
  });
  check("another assistant cannot carry on in it", !!carried.error);
  const { data: own } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "the owner's own" })
    .select("id")
    .single();
  const intoOwn = await A.rpc("abo_client_ask", {
    p_project: project.id,
    p_request: "written in theirs",
    p_conversation: own.id,
  });
  check("nor write in one the owner started", !!intoOwn.error);
  const elsewhere = await A.rpc("abo_client_ask", { p_project: theirs.id, p_request: "in a stranger's app" });
  check("nor ask in an app that is not the merchant's", !!elsewhere.error);

  console.log("\nand the wall it writes through still stands");
  const direct = await A.from("messages").insert({
    conversation_id: opened.conversation_id,
    role: "assistant",
    content: "",
    payload: { type: "answer", message: "straight in" },
  });
  check("a client still cannot write a message itself", !!direct.error);
  const thread = await A.from("conversations").insert({ project_id: project.id, title: "straight in" });
  check("nor a conversation", !!thread.error);
} finally {
  await project.remove();
  await theirs.remove();
  await admin.auth.admin.deleteUser(stranger.user.id);
  for (const c of [ai, other]) {
    await c.revoke().catch(() => {});
    await admin.auth.admin.oauth.deleteClient(c.clientId).catch(() => {});
  }
}

console.log(
  fails.length === 0 ? "\nan ask opens its own conversation, and fills only its own answer" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
