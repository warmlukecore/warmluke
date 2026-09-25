// Correcting a prompt retires it, and nothing else.
//
// A merchant who mistyped can edit what they sent. What must not
// happen is the thread quietly losing the mistake, or losing more
// than the mistake: everything said BEFORE the corrected prompt is
// still the conversation, and everything said after it answered a
// question that no longer stands.
//
// The marking is one SQL function, which is where this looks. The
// browser only shows what the flag says.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-thread-edit.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "thread-edit");

try {
  // A thread of four: something settled, then the prompt they got
  // wrong and the answer it drew.
  const { data: thread } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "editing" })
    .select("id, updated_at")
    .single();

  const t = Date.now();
  const at = (n) => new Date(t + n).toISOString();
  const { data: written } = await admin
    .from("messages")
    .insert([
      {
        conversation_id: thread.id,
        role: "user",
        content: "first",
        payload: { kind: "asked", text: "first" },
        created_at: at(0),
      },
      {
        conversation_id: thread.id,
        role: "assistant",
        content: "answer one",
        payload: { type: "applied", message: "answer one" },
        created_at: at(1),
      },
      {
        conversation_id: thread.id,
        role: "user",
        content: "teh wrong one",
        payload: { kind: "asked", text: "teh wrong one" },
        created_at: at(2),
      },
      {
        conversation_id: thread.id,
        role: "assistant",
        content: "answer two",
        payload: { type: "applied", message: "answer two" },
        created_at: at(3),
      },
    ])
    .select("id, content, created_at");

  const mistake = written.find((m) => m.content === "teh wrong one");
  const marked = async () =>
    Object.fromEntries(
      (await admin.from("messages").select("content, payload").eq("conversation_id", thread.id)).data.map((m) => [
        m.content,
        m.payload?.superseded === true,
      ])
    );

  console.log("before the edit, nothing is retired");
  const before = await marked();
  check(
    "the thread reads as written",
    Object.values(before).every((v) => v === false)
  );

  console.log("\ncorrecting a prompt retires it and what it drew");
  // Called as the owner's browser calls it: their session, not the
  // service key. SECURITY INVOKER means row-level security is what
  // decides, so a check that used the master key would prove nothing
  // about the person actually doing it.
  const owner = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  });
  const { data: count, error } = await owner.rpc("abo_supersede_from", { p_message: mistake.id });
  check("the owner may retire their own", !error);
  if (error) console.log("     →", error.message);
  check("it retired the prompt and the reply, and said so", count === 2);

  const after = await marked();
  check("the corrected prompt is marked", after["teh wrong one"] === true);
  check("and the answer it drew", after["answer two"] === true);
  // The half that matters most: an edit is not a way to erase the
  // conversation above it.
  check("what came before is untouched", after["first"] === false && after["answer one"] === false);

  console.log("\nand the thread says it moved");
  const { data: moved } = await admin.from("conversations").select("updated_at").eq("id", thread.id).single();
  // Whoever is watching this thread reloads on that, which is how the
  // second tab and the panel itself hear about the edit.
  check("updated_at advanced", new Date(moved.updated_at) > new Date(thread.updated_at));

  console.log("\na message that is not there retires nothing");
  // The same branch a caller hits when the message is not theirs to
  // see: row-level security hides it, the lookup finds nothing, and
  // the function does nothing and says nothing about why. Which of
  // the two it was is not the caller's business.
  const { data: none, error: refused } = await owner.rpc("abo_supersede_from", {
    p_message: "00000000-0000-0000-0000-000000000000",
  });
  check("it answers plainly", !refused);
  if (refused) console.log("     →", refused.message);
  check("and retires nothing", none === 0);
  const untouched = await marked();
  check("the thread it could not name is unchanged", untouched["first"] === false);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\nan edit retires exactly what it should" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
