// Designing it yourself, on your own subscription.
//
// propose_change runs Warmluke's engine on Warmluke's key, which is
// why it is capped. That cap was landing on merchants who had
// connected their own Claude and believed they were paying for it —
// and the refusal pointed them at a paywall that does not exist.
//
// submit_design is the honest version of what they thought was
// happening: their assistant writes the design, Warmluke checks it
// against the same validator its own model answers to, and no model
// runs on our side. Nothing to charge for, so nothing is charged.
//
// What this has to prove is that "free" did not also mean "unchecked".
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-byo-design.mjs

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
const token = owner.session.access_token;
const uid = owner.user.id;
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin
  .from("projects")
  .select("id, auto_build")
  .limit(1)
  .single();

const tool = async (name, args, id = 1) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};

const stamp = Date.now().toString(36);
const spent = async () =>
  (await admin.from("account_settings").select("turns_used").eq("user_id", uid).single()).data
    .turns_used;

const was = (
  await admin.from("account_settings").select("free_turns, turns_used").eq("user_id", uid).single()
).data;
const made = [];

try {
  // The whole point is that it works when the counter is empty.
  await admin.from("account_settings").update({ free_turns: 1, turns_used: 1 }).eq("user_id", uid);
  await admin.from("projects").update({ auto_build: false }).eq("id", project.id);

  console.log("the format is there to be read");
  const format = await tool("design_format", {});
  check("it says what a plan looks like", typeof format?.plan?.changeType === "string");
  check("and hands over the whole vocabulary", (format?.vocabulary ?? "").length > 500);
  check(
    "and is plain that deleting is not on offer",
    /MODULE_DELETE/.test(JSON.stringify(format?.removing_a_section ?? ""))
  );

  console.log("\nand a design that does not hold is refused");
  const nonsense = await tool(
    "submit_design",
    { plans: [{ changeType: "NOT_A_REAL_THING", explanation: "nope" }], project_id: project.id },
    2
  );
  check("it is not accepted", nonsense?.status === "not accepted");
  check("and it says what is wrong", Array.isArray(nonsense?.errors) && nonsense.errors.length > 0);

  // Free must not mean unchecked: the one operation a client may never
  // have is the one that cannot be undone.
  const deleting = await tool(
    "submit_design",
    {
      plans: [{ changeType: "MODULE_DELETE", targetModuleId: project.id, deleteConfirmName: "x" }],
      project_id: project.id,
    },
    3
  );
  check(
    "removing a section is still refused here",
    deleting?.status !== "waiting for approval" && deleting?.status !== "built"
  );

  console.log("\nand one that holds goes to the merchant");
  const good = await tool(
    "submit_design",
    {
      request: `BYO check ${stamp}`,
      project_id: project.id,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          // kebab-case, because the validator says so — it caught this
          // check's first attempt, which is the point of it existing.
          newModule: { name: `byo-${stamp}`, nav_label: `BYO ${stamp}`, icon: "table" },
          newSchema: {
            columns: [{ field: "note", label: "Note", type: "text" }],
            view: { type: "table" },
          },
          explanation: "Somewhere to write a note.",
        },
      ],
    },
    4
  );
  check("it waits for approval", good?.status === "waiting for approval");
  if (good?.status !== "waiting for approval") console.log("     →", JSON.stringify(good).slice(0, 300));
  check("and comes back with a request to approve", typeof good?.request_id === "string");
  if (good?.request_id) made.push(good.request_id);

  const row = good?.request_id
    ? (await admin.from("build_requests").select("status, approved_at, plans").eq("id", good.request_id).single()).data
    : null;
  check("the design is stored, not just described", (row?.plans ?? []).length === 1);
  // 0047: nothing may be built until somebody says yes, and this one
  // has not been said yes to.
  check("and nobody has approved it", row?.approved_at === null);

  console.log("\nand what is waiting can be asked for, not remembered");
  // Without this tool the model had no way to learn a request_id
  // except from its own memory of proposing one — so it listed designs
  // the merchant had long since dismissed and called them pending.
  const waiting = await tool("pending_changes", { project_id: project.id }, 6);
  check("the one just submitted is waiting", waiting?.total >= 1);
  check(
    "and it is named with the id approve_change wants",
    (waiting?.waiting ?? []).some((w) => w.request_id === good?.request_id)
  );
  check(
    "and it is not pretending to be approved",
    (waiting?.waiting ?? []).every((w) => w.state !== "approved, not built yet")
  );

  // Three different situations were being described with one sentence
  // about needing approval.
  const one = (waiting?.waiting ?? []).find((w) => w.request_id === good?.request_id);
  check("a request nobody stamped says so", one?.state === "awaiting_approval");
  check("and this connection may act on it", one?.you_can_approve_it === true);
  check("and it is not credited to an assistant", /merchant/i.test(one?.raised_by ?? ""));
  check("and it says what to do next", (one?.next_action ?? "").length > 0);

  // Approved is not the same as awaiting approval; saying so sent the
  // model back to ask for a yes it already had.
  await admin
    .from("build_requests")
    .update({ approved_at: new Date().toISOString() })
    .eq("id", good.request_id);
  const stamped = await tool("pending_changes", { project_id: project.id }, 8);
  check(
    "an approved one stops asking for approval",
    (stamped?.waiting ?? []).find((w) => w.request_id === good.request_id)?.state ===
      "approved, not built yet"
  );

  // A second connected assistant's request is not this one's to build
  // — the database already refuses it, so advertising the id would
  // hand the model something it cannot act on.
  const { data: other } = await admin
    .from("build_requests")
    .insert({
      project_id: project.id,
      requested_by: uid,
      client_id: "some-other-assistant",
      request: `raised elsewhere ${stamp}`,
      plans: [],
      status: "pending",
    })
    .select("id")
    .single();
  made.push(other.id);
  const mixed = await tool("pending_changes", { project_id: project.id }, 10);
  const theirs = (mixed?.waiting ?? []).find((w) => w.request_id === other.id);
  check("another assistant's request is named as theirs", /another assistant/i.test(theirs?.raised_by ?? ""));

  // The count has to be the whole count, not the size of the page.
  check("it says how many there are in total", typeof waiting?.total === "number");
  check("and how many it actually listed", typeof waiting?.showing === "number");

  // An id that is not theirs used to answer "nothing is waiting" —
  // the same lie, about the wrong app.
  const foreign = await tool(
    "pending_changes",
    { project_id: "11111111-2222-3333-4444-555555555555" },
    9
  );
  check("an app that is not theirs is an error", typeof foreign?.error === "string");
  check("not an empty queue", foreign?.total === undefined);
  check("and it names the apps they do have", Array.isArray(foreign?.projects));

  // The half that was actually going wrong: when nothing waits, the
  // answer has to be a plain no.
  for (const r of made) await admin.from("build_requests").update({ status: "dismissed" }).eq("id", r);
  const empty = await tool("pending_changes", { project_id: project.id }, 7);
  check("a dismissed design stops waiting", empty?.total === 0);
  check(
    "and the model is told not to claim otherwise",
    /do not tell the merchant otherwise/i.test(empty?.note ?? "")
  );

  console.log("\nand none of it was charged for");
  check("the counter never moved", (await spent()) === 1);

  // The other door still charges, because the other door still runs
  // our model. This is the line the whole change rests on.
  const paid = await tool("propose_change", { request: "Add a Suppliers section.", project_id: project.id }, 5);
  check(
    "while Warmluke doing the designing still needs a turn",
    /free builds/i.test(paid?.error ?? "")
  );
  check(
    "and now points at the free way instead of a paywall",
    paid?.do_this_instead === "design_format"
  );
} finally {
  for (const id of made) await admin.from("build_requests").delete().eq("id", id);
  await admin
    .from("account_settings")
    .update({ free_turns: was.free_turns, turns_used: was.turns_used })
    .eq("user_id", uid);
  await admin
    .from("projects")
    .update({ auto_build: project.auto_build === true })
    .eq("id", project.id);
  const back = (
    await admin.from("account_settings").select("free_turns, turns_used").eq("user_id", uid).single()
  ).data;
  check(
    "the account is back as it was",
    back.free_turns === was.free_turns && back.turns_used === was.turns_used
  );
}

console.log(
  fails.length === 0
    ? "\nthey pay for their own thinking, and it is still checked"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
