// "You check this often: shall I keep it?" (lib/repeat-ask).
//
// Pure: a new ask, or one repeated only the same day, is not one they keep
// asking; asked like this on other days, for the third time, it is, with
// how often; a topic offered once is not offered again; the message just
// saved is not counted as an earlier ask; Luke is told to answer first,
// offer once, and build nothing unasked. Live, on the check project, under
// the owner's own rights: their asks across threads are read, and an
// answer marked as having offered stops the offer.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-repeat-ask.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { describeRepeat, repeatFor, repeatOf } from "../src/lib/repeat-ask.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const NOW = Date.parse("2026-10-16T10:00:00Z");
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();

console.log("one they keep asking");
const ask = "How many COD orders are still unpaid this week?";
check("a new ask is not", repeatOf(ask, [], [], NOW) === null);
check(
  "asked again the same day is not a habit",
  repeatOf(
    ask,
    [
      { text: "COD orders still unpaid this week?", at: day(0) },
      { text: "unpaid COD orders this week", at: day(0) },
    ],
    [],
    NOW
  ) === null
);
const habit = repeatOf(
  ask,
  [
    { text: "COD orders still unpaid this week?", at: day(3) },
    { text: "how many unpaid COD orders this week", at: day(7) },
    { text: "Show me best sellers", at: day(2) },
  ],
  [],
  NOW
);
check("asked like this on other days, the third time, it is", habit?.times === 3 && habit?.days === 3);
check("a different question is not counted with it", habit?.times === 3);
check(
  "offered once, not again",
  repeatOf(
    ask,
    [
      { text: "COD orders still unpaid this week?", at: day(3) },
      { text: "unpaid COD orders this week", at: day(7) },
    ],
    [habit.key],
    NOW
  ) === null
);
check(
  "the message just saved is not an earlier ask",
  repeatOf(
    ask,
    [
      { text: ask, at: new Date(NOW - 30_000).toISOString() },
      { text: "COD orders still unpaid this week?", at: day(3) },
    ],
    [],
    NOW
  ) === null
);
check(
  "a word or two is too little to compare",
  repeatOf(
    "hi",
    [
      { text: "hi", at: day(2) },
      { text: "hi", at: day(4) },
    ],
    [],
    NOW
  ) === null
);
const told = describeRepeat(habit);
check(
  "Luke answers first, offers once, builds nothing unasked",
  /Answer it first/.test(told) && /once/.test(told) && /Build nothing unless they say yes/.test(told)
);
check("and nothing is said when it is not one", describeRepeat(null) === null);

// Live, on the check project.
const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`\n${envFile} does not declare CHECK_PROJECT=1, and this writes; the table is not checked`);
  process.exit(fails.length === 0 ? 0 : 1);
}
const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anonKey), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const owner = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "repeat ask");
try {
  console.log("\nread under the owner's own rights, across their threads");
  const thread = async (texts) => {
    const { data } = await admin
      .from("conversations")
      .insert({ project_id: project.id, title: "t" })
      .select("id")
      .single();
    for (const [text, at] of texts)
      await admin
        .from("messages")
        .insert({ conversation_id: data.id, role: "user", content: text, payload: { text }, created_at: at });
    return data.id;
  };
  const real = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  await thread([["COD orders still unpaid this week?", real(3)]]);
  const later = await thread([["how many unpaid COD orders this week", real(1)]]);
  const found = await repeatFor(owner, project.id, ask);
  check("asked in two threads on two days, now the third: offered", found?.times === 3);
  await admin.from("messages").insert({
    conversation_id: later,
    role: "assistant",
    content: "Here they are. Want me to keep this as a view?",
    payload: { type: "answer", message: "…", offered_repeat: found?.key },
  });
  check("once offered, not again", (await repeatFor(owner, project.id, ask)) === null);
} finally {
  await project.remove();
}

console.log(
  fails.length
    ? `\n${fails.length} FAILED`
    : "\nwhat they keep asking is offered once to keep, and nothing is built unasked"
);
process.exit(fails.length ? 1 : 0);
