// What already happened to this app, asked rather than remembered.
//
// The assistant could not answer "what did we change last week?" at
// all, and pending_changes is not history — it is the queue. So the
// only source was the model's memory of its own conversation, which
// is exactly how it came to tell a merchant that three dismissed
// designs were waiting for them.
//
// The half-built ones matter most here. A history that lists them as
// done is worse than no history: it is the sentence "that is already
// built" said about a section missing half its fields.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-build-history.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
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

// Calls this run makes count against the hourly ceiling; its own are
// not a merchant's, and left counted they lock the next run out.
const runStartedAt = new Date().toISOString();

const tool = async (name, args, id = 1) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${owner.session.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};

const stamp = Date.now().toString(36);
const made = [];

/** A finished request of a given shape, at a given moment. */
const past = async (label, status, minutesAgo, outcome = null) => {
  const when = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const { data } = await admin
    .from("build_requests")
    .insert({
      project_id: project.id,
      requested_by: owner.user.id,
      request: `history ${label} ${stamp}`,
      plans: [],
      status,
      approved_at: when,
      built_at: status === "dismissed" ? null : when,
      created_at: when,
      outcome,
    })
    .select("id")
    .single();
  if (data) made.push(data.id);
  return data?.id;
};

try {
  await past("whole", "built", 30, {
    applied: [{ changeType: "NEW_MODULE", navLabel: "H" }],
    errors: [],
  });
  await past("half", "partly_built", 20, {
    applied: [{ changeType: "NEW_MODULE", navLabel: "H" }],
    errors: ["fields failed"],
  });
  await past("gone", "dismissed", 10);
  // Still waiting — belongs to the other tool, not this one.
  const { data: waiting } = await admin
    .from("build_requests")
    .insert({
      project_id: project.id,
      requested_by: owner.user.id,
      request: `history waiting ${stamp}`,
      plans: [],
      status: "pending",
    })
    .select("id")
    .single();
  made.push(waiting.id);

  console.log("what happened to this app");
  const all = await tool("build_history", { project_id: project.id, limit: 50 });
  const mine = (all?.history ?? []).filter((h) => String(h.asked_for).endsWith(stamp));
  check("the finished ones are there", mine.length === 3);
  check("newest first", mine[0]?.asked_for.includes("gone"));
  check(
    "and what is still waiting is not",
    !JSON.stringify(mine).includes(`history waiting ${stamp}`)
  );
  check("it says where the waiting ones live", /pending_changes/.test(all?.note ?? ""));

  console.log("\nand the ones that only half worked");
  const half = mine.find((h) => h.asked_for.includes("half"));
  check("are not described as built", half?.state === "partly built");
  check("with the part that worked named", (half?.built ?? []).length === 1);
  check("and the part that did not", (half?.did_not_build ?? []).length === 1);
  check(
    "and the whole answer warns about them",
    /only partly worked/i.test(all?.needs_attention ?? "")
  );

  const whole = mine.find((h) => h.asked_for.includes("whole"));
  check("a finished one is just built", whole?.state === "built");
  check("and says when", typeof whole?.finished === "string");
  const gone = mine.find((h) => h.asked_for.includes("gone"));
  check("a dismissed one says so rather than vanishing", gone?.state === "dismissed");

  // Nothing in a history is approvable. Saying otherwise hands the
  // model an id it cannot act on — approve_change refuses every one
  // of these, so the field has to agree with the database.
  check(
    "and nothing finished claims it can be approved",
    mine.every((h) => h.you_can_approve_it === false)
  );

  console.log("\nand there is a way to keep going back");
  const firstPage = await tool("build_history", { project_id: project.id, limit: 2 }, 2);
  check("a page is the size asked for", firstPage?.showing === 2);
  check("it says there is more", typeof firstPage?.next_before === "string");
  const secondPage = await tool(
    "build_history",
    { project_id: project.id, limit: 2, before: firstPage.next_before },
    3
  );
  const firstIds = (firstPage.history ?? []).map((h) => h.request_id);
  check(
    "and the next page is not the same page",
    (secondPage?.history ?? []).every((h) => !firstIds.includes(h.request_id))
  );

  console.log("\nand an app that is not theirs");
  const foreign = await tool(
    "build_history",
    { project_id: "11111111-2222-3333-4444-555555555555" },
    4
  );
  check("is an error, not an empty history", typeof foreign?.error === "string");
  check("and names the apps they do have", Array.isArray(foreign?.projects));
} finally {
  await admin
    .from("mcp_calls")
    .delete()
    .eq("user_id", owner.user.id)
    .gte("created_at", runStartedAt);
  for (const id of made) await admin.from("build_requests").delete().eq("id", id);
  const { count } = await admin
    .from("build_requests")
    .select("id", { count: "exact", head: true })
    .like("request", `%${stamp}`);
  check("nothing this check invented is left in the history", (count ?? 0) === 0);
}

console.log(fails.length === 0 ? "\nthe history is the whole history" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
