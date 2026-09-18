// Which part of a long conversation survives.
//
// Both queries ordered ascending and then took a limit, which keeps the
// OLDEST rows. So past thirty messages the assistant replayed the start
// of the conversation for ever: it asked again for answers it had been
// given, and designed against requirements the owner had already
// replaced. Reopening a long thread showed the same stale beginning.
//
// The window is allowed to be small. It is not allowed to be the wrong
// end of the thread.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-thread-window.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("no OWNER_PASSWORD given — nothing to check");
  process.exit(0);
}
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin.from("projects").select("id").limit(1).single();

const stamp = Date.now().toString(36);
const TURNS = 40;
/** Matches HISTORY_LIMIT in src/app/api/chat/route.ts. */
const WINDOW = 30;

const { data: thread } = await admin
  .from("conversations")
  .insert({ project_id: project.id, title: `window ${stamp}` })
  .select("id")
  .single();

try {
  // Numbered, so the answer says plainly which end came back.
  const rows = [];
  for (let i = 1; i <= TURNS; i++) {
    rows.push({
      conversation_id: thread.id,
      role: i % 2 ? "user" : "assistant",
      content: `turn ${i} ${stamp}`,
      payload: i % 2
        ? { text: `turn ${i} ${stamp}` }
        : { type: "applied", message: `turn ${i} ${stamp}` },
      created_at: new Date(Date.now() - (TURNS - i) * 60000).toISOString(),
    });
  }
  await admin.from("messages").insert(rows);

  console.log(`a thread of ${TURNS} messages, reopened`);
  const res = await fetch(`${APP}/api/chat?projectId=${project.id}&id=${thread.id}`, {
    headers: { Authorization: `Bearer ${owner.session.access_token}` },
  });
  const json = await res.json();
  const said = (json.messages ?? []).map((m) => m.payload?.text ?? m.payload?.message ?? "");

  check("the newest message is there", said.some((t) => t.includes(`turn ${TURNS} `)));
  check("and the oldest too, at this length", said.some((t) => t.includes(`turn 1 `)));
  // Order is not decoration: a conversation read backwards is worse
  // than half a conversation.
  check(
    "oldest first, newest last",
    said.findIndex((t) => t.includes(`turn 1 `)) <
      said.findIndex((t) => t.includes(`turn ${TURNS} `))
  );

  // The half that was actually broken: with more messages than the
  // window, the kept ones must be the recent end.
  console.log("\nand the window the model is given");
  const newest = await admin
    .from("messages")
    .select("content")
    .eq("conversation_id", thread.id)
    .order("created_at", { ascending: false })
    .limit(WINDOW);
  const kept = (newest.data ?? []).map((m) => m.content);
  check(`the last ${WINDOW} are the ones kept`, kept.some((t) => t.includes(`turn ${TURNS} `)));
  check("and the very first is dropped", !kept.some((t) => t === `turn 1 ${stamp}`));
} finally {
  // Messages cascade with the conversation.
  await admin.from("conversations").delete().eq("id", thread.id);
  const { count } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .like("content", `%${stamp}`);
  check("nothing this check said is left in any thread", (count ?? 0) === 0);
}

console.log(
  fails.length === 0 ? "\nit remembers the end of the conversation" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
