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
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-byo-design.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

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
const owner = await signInAsCheckUser(client, env);
if (!owner.session) {
  console.log(`could not sign in as the owner — ${owner.why}`);
  process.exit(1);
}
const token = owner.session.access_token;
const uid = owner.user.id;
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
// A project for this run only — the check user's, not the merchant's.
const project = await throwawayProject(admin, uid, "byo-design");

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


// Calls this run makes count against the account's hourly ceiling, so
// after a few runs the check cannot reach the server it is checking.
// Its own calls are not a merchant's; they are swept at the end.
const runStartedAt = new Date().toISOString();
const sweepOwnCalls = async (userId) => {
  await admin.from("mcp_calls").delete().eq("user_id", userId).gte("created_at", runStartedAt);
};

const stamp = Date.now().toString(36);
const spent = async () =>
  (await admin.from("account_settings").select("turns_used").eq("user_id", uid).single()).data
    .turns_used;

const { data: was, error: settingsError } = await admin
  .from("account_settings")
  .select("free_turns, turns_used, turns_unlimited")
  .eq("user_id", uid)
  .single();
if (settingsError || !was) {
  throw new Error(`could not snapshot the account before the check: ${settingsError?.message ?? "no settings row"}`);
}
const made = [];

try {
  // The whole point is that it works when the counter is empty.
  const limited = await admin
    .from("account_settings")
    .update({ free_turns: 1, turns_used: 1, turns_unlimited: false })
    .eq("user_id", uid);
  if (limited.error) throw new Error(`could not establish the test allowance: ${limited.error.message}`);
  await admin.from("projects").update({ auto_build: false }).eq("id", project.id);

  console.log("the format is there to be read");
  const format = await tool("design_format", {});
  // It used to answer with prose ABOUT the shape — "features: filters,
  // search, sorting, stats — see the vocabulary" — which names the
  // parts and not one key, and is what sent a client guessing at
  // "operator" / "op" / "type" through eight rejected submissions.
  const shape = String(format?.plan_format ?? "");
  check("it says what a plan looks like", shape.length > 500);
  check('naming the operator key out loud', /"op": "\*"/.test(shape));
  check('and putting "view" where it really goes', shape.indexOf('"features": {') < shape.indexOf('"view": { "type": "board"'));
  check(
    "and it carries a design that actually validates",
    Array.isArray(format?.worked_example?.plans) && format.worked_example.plans.length > 0
  );
  check("and hands over the whole vocabulary", (format?.vocabulary ?? "").length > 500);
  check(
    "and is plain that deleting is not on offer",
    /MODULE_DELETE/.test(JSON.stringify(format?.removing_a_section ?? ""))
  );

  console.log("\nand the worked example is not just decoration");
  {
    // Checking it through the dry run proves two things at once: that
    // validate_design changes nothing, and that what design_format
    // hands out is a design this server would actually accept.
    const dry = await tool(
      "validate_design",
      { plans: format.worked_example.plans, project_id: project.id },
      21
    );
    check("the example design holds", dry?.status === "holds");
    if (dry?.status !== "holds") console.log(`     said: ${JSON.stringify(dry?.errors ?? dry)}`);
    check("and nothing was put in front of the merchant", !dry?.request_id);
  }

  console.log("\nand a dry run of a broken design changes nothing either");
  {
    const dry = await tool(
      "validate_design",
      { plans: [{ changeType: "NOT_A_REAL_THING", explanation: "nope" }], project_id: project.id },
      22
    );
    check("it is not accepted", dry?.status === "not accepted");
    check("and says it was a dry run", /dry run/.test(String(dry?.note ?? "")));
  }

  console.log("\nand a design that does not hold is refused");
  const nonsense = await tool(
    "submit_design",
    { plans: [{ changeType: "NOT_A_REAL_THING", explanation: "nope" }], project_id: project.id },
    2
  );
  check("it is not accepted", nonsense?.status === "not accepted");
  check("and it says what is wrong", Array.isArray(nonsense?.errors) && nonsense.errors.length > 0);

  // The design a real merchant's Claude sent, verbatim. A dashboard
  // over the store's orders, with every field named the way Shopify's
  // API names it — total_price, created_at, fulfillment_status — and
  // refused seven times over. Two things were wrong, and only one of
  // them was the client's: the section did not exist yet, so its
  // columns were looked up on whatever section was open instead of on
  // the orders table; and the refusal named nothing it could type.
  console.log("\na dashboard over the store's orders, in Shopify's words");
  const dashboard = (financial, fulfilment, total, placed) => ({
    request: `BYO dashboard ${stamp}`,
    project_id: project.id,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: `dash-${stamp}`, nav_label: `Dash ${stamp}`, icon: "table", source_table: "orders" },
        newSchema: null,
        explanation: "All your orders, read-only and always in sync.",
      },
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: `#dash-${stamp}`,
        features: {
          defaultSort: { dir: "desc", field: placed },
          filters: [
            { field: financial, label: "Financial", options: ["PENDING", "PAID", "REFUNDED"] },
            { field: fulfilment, label: "Fulfilment", options: ["UNFULFILLED", "FULFILLED"] },
          ],
          search: { enabled: true, fields: ["order_number"], placeholder: "Search order number…" },
          stats: [
            { label: "Total Orders", op: "count" },
            { field: total, label: "Total Revenue", op: "sum" },
          ],
        },
        explanation: "Search, filters and revenue on top of the synced orders.",
      },
    ],
  });
  const guessed = await tool(
    "submit_design",
    dashboard("financial_status", "fulfillment_status", "total_price", "created_at"),
    23
  );
  check("Shopify's names are refused", guessed?.status === "not accepted");
  const refusal = (guessed?.errors ?? []).join("\n");
  check("and the refusal names the columns that exist", /This section's columns are:/.test(refusal));
  check("including the one it wanted", /fulfilment_status/.test(refusal) && /placed_at/.test(refusal));
  if (!/fulfilment_status/.test(refusal)) console.log("     →", refusal.slice(0, 400));

  // design_format is where it should have read them in the first place.
  const dfmt = await tool("design_format", { project_id: project.id }, 24);
  const orderCols = dfmt?.store_columns?.orders ?? [];
  check("design_format lists the store's columns by table", orderCols.includes("fulfilment_status"));
  check("and all four tables", ["orders", "customers", "products", "inventory_levels"].every((t) => Array.isArray(dfmt?.store_columns?.[t])));

  // With the real names, the same design holds — which it did not
  // before either, because the section had no columns to be checked
  // against until it existed.
  const right = await tool(
    "submit_design",
    dashboard("status", "fulfilment_status", "total", "placed_at"),
    25
  );
  check("and with Warmluke's names it is accepted", right?.status === "waiting for approval");
  if (right?.status !== "waiting for approval") console.log("     →", JSON.stringify(right).slice(0, 400));
  if (right?.request_id) made.push(right.request_id);

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

  // A half-built request is waiting for nobody, and that is exactly why
  // it used to be invisible: a section exists with half of what was
  // asked for and nothing on any screen says so.
  await admin
    .from("build_requests")
    .update({
      status: "partly_built",
      outcome: { applied: [{ changeType: "NEW_MODULE", navLabel: "BYO" }], errors: ["fields failed"] },
    })
    .eq("id", other.id);
  const broken = await tool("pending_changes", { project_id: project.id }, 11);
  const hurt = (broken?.waiting ?? []).find((w) => w.request_id === other.id);
  check("a half-built request is still shown", hurt !== undefined);
  check("and called what it is", hurt?.state === "partly built");
  check("with the part that worked named", (hurt?.built ?? []).length === 1);
  check("and the part that did not", (hurt?.did_not_build ?? []).length === 1);
  check(
    "and it does not send them back to approve_change",
    /will not finish this one/i.test(hurt?.next_action ?? "")
  );

  console.log("\nand a no is a decision, not a silence");
  // Until this existed, a merchant refusing a design inside their own
  // assistant changed nothing: the queue went on saying it was waiting
  // and the bell went on counting it.
  const toRefuse = await tool(
    "submit_design",
    {
      request: `BYO refuse ${stamp}`,
      project_id: project.id,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: `byo-no-${stamp}`, nav_label: `BYO No ${stamp}`, icon: "table" },
          newSchema: {
            columns: [{ field: "note", label: "Note", type: "text" }],
            view: { type: "table" },
          },
          explanation: "Somewhere to write a note.",
        },
      ],
    },
    12
  );
  made.push(toRefuse.request_id);

  const said = await tool(
    "reject_change",
    { request_id: toRefuse.request_id, reason: "they said they already have this in a spreadsheet" },
    13
  );
  check("it is recorded as dismissed", said?.status === "dismissed");
  if (said?.status !== "dismissed") {
    console.log(`     reject_change said: ${JSON.stringify(said).slice(0, 250)}`);
    console.log(`     the design it was given: ${JSON.stringify(toRefuse).slice(0, 250)}`);
  }

  const afterNo = await tool("pending_changes", { project_id: project.id }, 14);
  check(
    "and it stops waiting",
    !(afterNo?.waiting ?? []).some((w) => w.request_id === toRefuse.request_id)
  );
  const stored = (
    await admin.from("build_requests").select("status, summary").eq("id", toRefuse.request_id).single()
  ).data;
  check("the row says so too", stored?.status === "dismissed");
  check("with the merchant's reason kept", /spreadsheet/.test(stored?.summary ?? ""));

  // Asking twice is not an error — the answer is the state it is in.
  const twice = await tool("reject_change", { request_id: toRefuse.request_id }, 15);
  check("refusing twice changes nothing", twice?.status === "dismissed");
  check("and says it was already done", /already dismissed/i.test(twice?.note ?? ""));

  // Nothing finished can be refused: there is no decision left to make.
  const finished = await tool("reject_change", { request_id: other.id }, 16);
  check("a half-built one cannot be refused", finished?.status === "not rejected");

  const nobody = await tool(
    "reject_change",
    { request_id: "11111111-2222-3333-4444-555555555555" },
    17
  );
  check("nor one that is not theirs", nobody?.status === "not rejected");

  // The half that was actually going wrong: when nothing waits, the
  // answer has to be a plain no.
  //
  // Asked of the whole project this used to read "nothing is waiting
  // at all", which is not this run's business and not true on a real
  // account — the merchant's own AI had a design waiting, and the
  // check failed on a fact about their day. It asks only about the
  // rows it made.
  for (const r of made) await admin.from("build_requests").update({ status: "dismissed" }).eq("id", r);
  const empty = await tool("pending_changes", { project_id: project.id }, 7);
  const stillWaiting = (empty?.waiting ?? []).map((w) => w.request_id);
  check(
    "a dismissed design stops waiting",
    made.every((r) => !stillWaiting.includes(r))
  );
  // The note only appears when nothing at all waits, which is the
  // state this check can only claim when the account is quiet.
  if (empty?.total === 0) {
    check(
      "and the model is told not to claim otherwise",
      /do not tell the merchant otherwise/i.test(empty?.note ?? "")
    );
  } else {
    console.log(
      `  --    ${empty?.total} design(s) of the merchant's own are waiting, so the empty-note is not asked for`
    );
  }

  // Paging through the history, which nothing checked and which was
  // quietly broken: the answer hands back a key called `next_before`
  // and the parameter is called `before`, so a client that sent the
  // name it was given got no cursor, no error, and the same page for
  // ever.
  console.log("\nand the history can actually be paged");
  {
    const first = await tool("build_history", { project_id: project.id, limit: 1 }, 41);
    check("one at a time", (first?.history ?? []).length === 1);
    if (first?.next_before) {
      const byRightName = await tool(
        "build_history",
        { project_id: project.id, limit: 1, before: first.next_before },
        42
      );
      const a = first.history[0]?.request_id;
      const b = byRightName?.history?.[0]?.request_id;
      check("the next page is a different one", !!b && b !== a);

      // The spelling the answer itself suggests. It used to be
      // ignored, which is worse than refusing it.
      const byTheOtherName = await tool(
        "build_history",
        { project_id: project.id, limit: 1, next_before: first.next_before },
        43
      );
      check(
        "and the name the answer gives works too",
        byTheOtherName?.history?.[0]?.request_id === b
      );
    } else {
      check("there is a cursor to page with", false);
    }
  }

  console.log("\nand none of it was charged for");
  check("the counter never moved", (await spent()) === 1);

  // The other door still charges, because the other door still runs
  // our model. This is the line the whole change rests on.
  const paid = await tool("propose_change", { request: "Add a Suppliers section.", project_id: project.id }, 5);
  // Tracked even though it is expected to be refused. When it is NOT
  // refused it leaves a design waiting on the merchant's real account
  // for ever, and the next run of this check fails on a queue it was
  // told would be empty — which is exactly how it failed today.
  if (paid?.request_id) made.push(paid.request_id);
  // Asserted on what the refusal DOES, not on the words it uses. The
  // wording is marketing copy and has already been changed once on one
  // door and not the other; a check pinned to a phrase goes red for a
  // rewrite and stays green for a hole.
  check(
    "while Warmluke doing the designing still needs a turn",
    typeof paid?.error === "string" && /\b1\b/.test(paid.error) && !paid?.status
  );
  check(
    "and now points at the free way instead of a paywall",
    paid?.do_this_instead === "design_format"
  );
  if (!paid?.error) console.log(`     propose_change said: ${JSON.stringify(paid).slice(0, 300)}`);
} finally {
  // Restore real account state before disposable rows or rate-limit
  // calls are cleaned up. Each cleanup is isolated, so a network error
  // deleting one test request cannot skip the allowance restoration.
  // The restore is read back and retried: a failed update must make the
  // check fail loudly instead of leaving aaa@gmail.com at 49 / 1.
  const cleanupProblems = [];
  const restore = async (label, write, verify) => {
    let last = "did not verify";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await write();
        if (result?.error) {
          last = result.error.message;
          continue;
        }
        if (await verify()) return;
        last = "the read-back did not match";
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    cleanupProblems.push(`${label}: ${last}`);
  };

  await restore(
    "account allowance",
    () =>
      admin
        .from("account_settings")
        .update({
          free_turns: was.free_turns,
          turns_used: was.turns_used,
          turns_unlimited: was.turns_unlimited,
        })
        .eq("user_id", uid),
    async () => {
      const { data, error } = await admin
        .from("account_settings")
        .select("free_turns, turns_used, turns_unlimited")
        .eq("user_id", uid)
        .single();
      return (
        !error &&
        data?.free_turns === was.free_turns &&
        data?.turns_used === was.turns_used &&
        data?.turns_unlimited === was.turns_unlimited
      );
    }
  );

  await restore(
    "project auto-build state",
    () =>
      admin
        .from("projects")
        .update({ auto_build: project.auto_build === true })
        .eq("id", project.id),
    async () => {
      const { data, error } = await admin
        .from("projects")
        .select("auto_build")
        .eq("id", project.id)
        .single();
      return !error && data?.auto_build === (project.auto_build === true);
    }
  );

  try {
    await sweepOwnCalls(uid);
  } catch (error) {
    cleanupProblems.push(`MCP-call cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const id of made.filter(Boolean)) {
    try {
      const removed = await admin.from("build_requests").delete().eq("id", id);
      if (removed.error) cleanupProblems.push(`build request ${id}: ${removed.error.message}`);
    } catch (error) {
      cleanupProblems.push(`build request ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await project.remove();
  check("the account is back as it was", !cleanupProblems.some((x) => x.startsWith("account allowance:")));
  if (cleanupProblems.length > 0) {
    throw new Error(`cleanup failed after three attempts — ${cleanupProblems.join("; ")}`);
  }
}

console.log(
  fails.length === 0
    ? "\nthey pay for their own thinking, and it is still checked"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
