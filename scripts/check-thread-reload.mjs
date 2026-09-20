// What the panel shows after a refresh.
//
// "Built 1 change" is the receipt for something that actually happened
// to the merchant's app. It was written to the thread and then never
// read back: opening the app listed the threads and left the panel
// empty, so the receipt was there in the database and nowhere on the
// screen. A receipt that disappears reads as the build not happening.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-thread-reload.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { OWNER_EMAIL } from "./owner-session.mjs";

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

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const { data: owner } = await client.auth.signInWithPassword({
  email: OWNER_EMAIL,
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("no OWNER_PASSWORD given — nothing to check");
  process.exit(0);
}
const token = owner.session.access_token;
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin.from("projects").select("id").limit(1).single();

// The row recordOutcome() writes, written the same way it writes it.
const text = `✅ Built 1 change. (check ${Date.now().toString(36)})`;
const { data: thread } = await client
  .from("conversations")
  .insert({ project_id: project.id, title: text.slice(0, 80) })
  .select("id")
  .single();
await client.from("messages").insert({
  conversation_id: thread.id,
  role: "assistant",
  content: text,
  payload: { type: "applied", message: text },
});

const get = async (qs) =>
  (await fetch(`${APP}/api/chat?${qs}`, { headers: { Authorization: `Bearer ${token}` } })).json();

try {
  console.log("opening the app");
  const opened = await get(new URLSearchParams({ projectId: project.id, latest: "1" }));
  check("the newest thread comes back", opened.conversationId === thread.id);
  // The panel renders an unknown payload by its `message`, so that is
  // the field that has to survive, not `content`.
  check(
    "with the receipt in it",
    (opened.messages ?? []).some((m) => m.payload?.message === text)
  );

  // Re-listing after a failed turn must not claim a thread: the panel
  // has a message on screen it would replace.
  console.log("\nand re-listing alone");
  const listed = await get(new URLSearchParams({ projectId: project.id }));
  check("names no thread", listed.conversationId === null);
  check("and returns no messages", (listed.messages ?? []).length === 0);
  check("but still lists the threads", (listed.threads ?? []).some((t) => t.id === thread.id));
} finally {
  await admin.from("conversations").delete().eq("id", thread.id);
  console.log("\nthe test thread is removed");
}

console.log(fails.length === 0 ? "\nthe receipt survives a refresh" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
