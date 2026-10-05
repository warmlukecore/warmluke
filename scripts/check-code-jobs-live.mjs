// A rule's own code with nobody watching (0134): a new order from the
// store, and a rule on a schedule, each run by the worker on a ticket
// the database minted for one project.
//
// Built with no model, through /api/apply as Luke's design would be. An
// order the store brings in is queued for the rule waiting on one, and
// the worker writes the charge beside it; a scheduled rule is queued
// when its time has come, and adds its summary row. A made-up ticket is
// turned away; a real one reaches no other project. Needs a server that
// can reach a sandbox — without one the jobs fail saying so, and this
// says so and checks the rest.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-code-jobs-live.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("this writes, and the env file does not declare CHECK_PROJECT=1; nothing checked");
  process.exit(0);
}
const APP = process.env.APP_URL ?? "http://localhost:3100";
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(URL_, ANON), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${me.session.access_token}` };
const project = await throwawayProject(admin, me.user.id, "code jobs");
const other = await throwawayProject(admin, me.user.id, "code jobs, the other");
const ticketed = (t) =>
  createClient(URL_, ANON, { global: { headers: { "x-code-ticket": t } }, auth: { persistSession: false } });

try {
  const { data: store, error: se } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `code-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
    })
    .select("id")
    .single();
  if (se) throw new Error(`could not make the store: ${se.message}`);
  await seedShop(admin, store.id);
  // The first import done: from here a row the store brings in is news.
  await admin.from("stores").update({ last_synced_at: new Date().toISOString() }).eq("id", store.id);
  const { data: otherRec, error: oe } = await admin
    .from("modules")
    .insert({ project_id: other.id, name: "theirs", nav_label: "Theirs", icon: "table", route: "/modules/theirs" })
    .select("id")
    .single();
  if (oe) throw new Error(`could not make the other project's section: ${oe.message}`);
  await admin.from("records").insert({ project_id: other.id, module_id: otherRec.id, data: { secret: "theirs" } });

  const built = await fetch(`${APP}/api/apply`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: project.id,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "courier", nav_label: "Courier", icon: "table", source_table: "orders" },
          newSchema: { columns: [{ field: "courier_charge", label: "Courier charge", type: "currency" }] },
          explanation: "The store's orders, with a courier charge of theirs beside each.",
        },
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "day-notes", nav_label: "Day notes", icon: "table" },
          newSchema: { columns: [{ field: "note", label: "Note", type: "text" }] },
          explanation: "A line a day about the orders.",
        },
        {
          changeType: "AUTOMATION_ADD",
          targetModuleId: "#courier",
          automation: {
            name: "charge a new order",
            definition: {
              trigger: { type: "store_row_added" },
              actions: [
                {
                  type: "run_code",
                  code: "export default function run({ row }) { return { set: [{ id: row.id, fields: { courier_charge: Math.round(Number(row.total) * 0.1) } }] }; }",
                },
              ],
            },
          },
          explanation: "Works out the charge on each order the store brings in.",
        },
        {
          changeType: "AUTOMATION_ADD",
          targetModuleId: "#day-notes",
          automation: {
            name: "a line a day",
            definition: {
              trigger: { type: "schedule", every: "daily" },
              actions: [
                {
                  type: "run_code",
                  reads: ["#courier"],
                  // And says when it runs next: tomorrow at seven, on the store's clock (0138).
                  code: "export default function run({ sections, today }) { const n = (sections['#courier'] ?? []).length; const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return { add: [{ fields: { note: today + ': ' + n + ' orders' } }], next: d.toISOString().slice(0, 10) + 'T07:00' }; }",
                },
              ],
            },
          },
          explanation: "Writes one line a day on how many orders there are.",
        },
      ],
    }),
  });
  console.log("a design with two code rules that run with nobody watching");
  check("is built", built.status === 200);
  if (built.status !== 200) console.log("     →", (await built.text()).slice(0, 400));
  const { data: mods } = await admin.from("modules").select("id, name").eq("project_id", project.id);
  const idOf = (n) => mods.find((m) => m.name === n)?.id;

  console.log("\nan order the store brings in is queued for the rule waiting on one");
  const { data: order } = await admin
    .from("orders")
    .insert({
      store_id: store.id,
      external_id: `gid://shopify/Order/9${Date.now()}`,
      order_number: "#9001",
      total: 1250,
      currency: "INR",
    })
    .select("id")
    .single();
  const { data: added } = await admin
    .from("code_jobs")
    .select("id, kind, row_ids, status")
    .eq("project_id", project.id)
    .eq("kind", "added")
    .maybeSingle();
  check("one job, holding that order", added?.status === "queued" && added.row_ids.includes(order.id));

  console.log("\na rule on a schedule is queued when its time has come, once");
  await admin.rpc("abo_code_schedule");
  await admin.rpc("abo_code_schedule");
  const { data: sched } = await admin
    .from("code_jobs")
    .select("id")
    .eq("project_id", project.id)
    .eq("kind", "schedule");
  check("one job for it, however often the clock asks", sched?.length === 1);

  console.log("\nthe ticket");
  const { data: ticket } = await admin.rpc("abo_code_mint", { p_project: project.id });
  check("is minted for one project", typeof ticket === "string" && ticket.length >= 32);
  const { data: again } = await admin.rpc("abo_code_mint", { p_project: project.id });
  check("and not again while it lives", again === null);
  const t = ticketed(ticket);
  const { data: ours } = await t.from("modules").select("id").eq("project_id", project.id);
  check("it reads the project's sections", (ours ?? []).length === mods.length);
  const { data: theirs } = await t.from("records").select("id").eq("project_id", other.id);
  check("and no other project's records", (theirs ?? []).length === 0);
  const { data: tok, error: tokErr } = await t.from("stores").select("access_token").eq("project_id", project.id);
  check("nor the store's token", !!tokErr || (tok ?? []).every((s) => !s.access_token));
  // A rule that changes a row already there saves through abo_record_patch:
  // refused to the ticket, a daily rule failed every day in production (0179).
  const { data: mine, error: mineErr } = await admin
    .from("records")
    .insert({ project_id: project.id, module_id: idOf("day-notes"), data: { note: "a" } })
    .select("id")
    .single();
  if (mineErr) throw new Error(`could not make a row to change: ${mineErr.message}`);
  const { data: patched, error: patchErr } = await t.rpc("abo_record_patch", {
    p_record: mine.id,
    p_patch: { note: "b" },
  });
  check("it may change a row of the project's already there", !patchErr && patched?.status === "applied");
  if (patchErr) console.log("     →", patchErr.message);
  const { data: theirRow } = await admin.from("records").select("id").eq("project_id", other.id).limit(1).single();
  const { data: refused } = await t.rpc("abo_record_patch", { p_record: theirRow.id, p_patch: { secret: "ours" } });
  check("and none of another project's", refused?.status === "missing");
  await admin.from("records").delete().eq("id", mine.id);
  const bad = await fetch(`${APP}/api/code-rules/worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: project.id, ticket: "x".repeat(64) }),
  });
  check("a made-up ticket is turned away", bad.status === 403);

  console.log("\nthe worker, on the real ticket");
  const res = await fetch(`${APP}/api/code-rules/worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: project.id, ticket }),
  });
  check("takes the work", res.status === 202);
  let jobs = [];
  for (let i = 0; i < 120; i++) {
    ({ data: jobs } = await admin.from("code_jobs").select("kind, status, error").eq("project_id", project.id));
    if ((jobs ?? []).every((j) => j.status === "done" || j.status === "failed")) break;
    await wait(1000);
  }
  const unreachable = (jobs ?? []).some((j) => /no sandbox is reachable/.test(j.error ?? ""));
  if (unreachable) {
    console.log("  skip  this server cannot reach a sandbox: the jobs failed saying so, and nothing was written");
    check(
      "and said so",
      (jobs ?? []).every((j) => j.status === "failed")
    );
  } else {
    check("both jobs ran", (jobs ?? []).length === 2 && jobs.every((j) => j.status === "done"));
    if (!jobs.every((j) => j.status === "done")) console.log("     →", JSON.stringify(jobs));
    const { data: charged } = await admin
      .from("records")
      .select("data")
      .eq("module_id", idOf("courier"))
      .eq("store_row_id", order.id)
      .maybeSingle();
    check("the new order is charged beside the store's row: 10% of 1250 = 125", charged?.data?.courier_charge === 125);
    const { data: notes } = await admin.from("records").select("data").eq("module_id", idOf("day-notes"));
    check(
      "and the day's line is written",
      (notes ?? []).length === 1 && String(notes[0].data.note).endsWith(" orders")
    );
    const { data: dayRule } = await admin
      .from("automations")
      .select("next_run_at")
      .eq("project_id", project.id)
      .eq("name", "a line a day")
      .single();
    const nextAt = dayRule?.next_run_at ? new Date(dayRule.next_run_at) : null;
    const wall = nextAt
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(nextAt)
      : "";
    check(
      "and its code says when it runs next: tomorrow at 07:00, the store's time",
      wall === "07:00" && nextAt > new Date()
    );
  }
  let lease = [];
  for (let i = 0; i < 20; i++) {
    ({ data: lease } = await admin.from("code_leases").select("project_id").eq("project_id", project.id));
    if (!(lease ?? []).length) break;
    await wait(500);
  }
  check("the ticket is given back when the work is done", (lease ?? []).length === 0);

  // A worker that died leaves its job running. Before 0134's fix the clock
  // put it back on the queue beside the rule's open job, which the one-open
  // index refuses, and every tick after failed for every project.
  console.log("\na job whose worker died");
  const { data: rules } = await admin.from("automations").select("id, name").eq("project_id", project.id);
  const ruleOf = (n) => rules.find((r) => r.name === n).id;
  const long = new Date(Date.now() - 20 * 60_000).toISOString();
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  const job = async (row) =>
    (
      await admin
        .from("code_jobs")
        .insert({ project_id: project.id, ...row })
        .select("id")
        .single()
    ).data.id;
  const died = { status: "running", started_at: long };
  const dead = await job({
    automation_id: ruleOf("charge a new order"),
    kind: "added",
    row_ids: [a],
    attempts: 1,
    ...died,
  });
  const open = await job({ automation_id: ruleOf("charge a new order"), kind: "added", row_ids: [b] });
  const alone = await job({ automation_id: ruleOf("a line a day"), kind: "schedule", attempts: 1, ...died });
  const spent = await job({ automation_id: ruleOf("a line a day"), kind: "added", row_ids: [a], attempts: 3, ...died });
  const { error: tickErr } = await admin.rpc("abo_code_tick");
  check("the clock goes on", !tickErr);
  if (tickErr) console.log("     →", tickErr.message);
  const { data: now } = await admin
    .from("code_jobs")
    .select("id, status, row_ids")
    .in("id", [dead, open, alone, spent]);
  const at = Object.fromEntries((now ?? []).map((j) => [j.id, j]));
  check(
    "its rows join the rule's open job, and it is closed",
    at[open]?.row_ids.includes(a) && at[open].row_ids.includes(b) && at[dead]?.status === "failed"
  );
  check("with no open job, it goes back on the queue", at[alone]?.status === "queued");
  check("and after three tries it is closed, not left running", at[spent]?.status === "failed");

  // What the clock sends: the check project never has code_worker_url, so
  // the tick returns before it sends, and a variable in it that read as a
  // column failed every tick in production once the url was set (0136).
  // Its choice is asked directly.
  const { data: waiting, error: waitErr } = await admin.rpc("abo_code_waiting");
  check("the clock would send this project its queued code", !waitErr && (waiting ?? []).includes(project.id));
  if (waitErr) console.log("     →", waitErr.message);
  const { data: held } = await admin.rpc("abo_code_mint", { p_project: project.id });
  const { data: stillWaiting } = await admin.rpc("abo_code_waiting");
  check("and not while a worker is on it", typeof held === "string" && !(stillWaiting ?? []).includes(project.id));
  await admin.from("code_leases").delete().eq("project_id", project.id);

  // A schedule at a time of day, on the store's clock (0137). Asked at
  // moments of the check's choosing, so the answers do not depend on when
  // it runs. The store here keeps Asia/Kolkata, UTC+05:30.
  console.log("\na schedule at a time, on the store's clock");
  const tz = { p_tz: "Asia/Kolkata" };
  const slot = async (trigger, now) =>
    (await admin.rpc("abo_schedule_slot", { p_trigger: trigger, ...tz, p_now: now })).data;
  const due = async (trigger, last, made, now) =>
    (await admin.rpc("abo_schedule_due", { p_trigger: trigger, ...tz, p_last: last, p_made: made, p_now: now })).data;
  const same = (a, b) => typeof a === "string" && Date.parse(a) === Date.parse(b);
  const seven = { type: "schedule", every: "daily", at: "07:00" };
  check(
    "asked in the evening: this morning's seven",
    same(await slot(seven, "2026-09-29T12:00:00Z"), "2026-09-29T01:30:00Z")
  );
  check("asked before seven: yesterday's", same(await slot(seven, "2026-09-29T01:00:00Z"), "2026-09-28T01:30:00Z"));
  check(
    "every Monday at nine, asked on a Wednesday: Monday's",
    same(
      await slot({ type: "schedule", every: "weekly", on: ["mon"], at: "09:00" }, "2026-09-30T12:00:00Z"),
      "2026-09-28T03:30:00Z"
    )
  );
  check(
    "Monday to Saturday, asked on a Sunday: Saturday's",
    same(
      await slot(
        { type: "schedule", every: "daily", on: ["mon", "tue", "wed", "thu", "fri", "sat"], at: "09:00" },
        "2026-09-27T12:00:00Z"
      ),
      "2026-09-26T03:30:00Z"
    )
  );
  check(
    "the 31st, in a month of thirty days, is its last",
    same(await slot({ type: "schedule", every: "monthly", date: 31 }, "2026-09-30T12:00:00Z"), "2026-09-29T18:30:00Z")
  );
  check(
    "an interval alone names no moment",
    (await slot({ type: "schedule", every: "daily" }, "2026-09-29T12:00:00Z")) === null
  );
  check(
    "made after this morning's seven, it waits for tomorrow's",
    (await due(seven, null, "2026-09-29T11:00:00Z", "2026-09-29T12:00:00Z")) === false
  );
  check("made before it, it is due", (await due(seven, null, "2026-09-28T00:00:00Z", "2026-09-29T12:00:00Z")) === true);
  check(
    "and not again once it ran",
    (await due(seven, "2026-09-29T01:31:00Z", "2026-09-28T00:00:00Z", "2026-09-29T12:00:00Z")) === false
  );
  const daily = { type: "schedule", every: "daily" };
  check(
    "an interval, as before: a day after its last run",
    (await due(daily, "2026-09-28T13:00:00Z", "2026-09-01T00:00:00Z", "2026-09-29T12:00:00Z")) === false &&
      (await due(daily, "2026-09-28T12:00:00Z", "2026-09-01T00:00:00Z", "2026-09-29T12:00:00Z")) === true
  );

  // The code clock itself: a rule whose time has come is queued, one made since waits.
  const home = mods[0].id;
  const timed = (name, made) => ({
    project_id: project.id,
    module_id: home,
    name,
    enabled: true,
    created_at: made,
    definition: {
      trigger: { type: "schedule", every: "daily", at: "00:00" },
      actions: [{ type: "run_code", code: "export default function run() { return { set: [], add: [] }; }" }],
    },
  });
  const { data: timedRules, error: timedErr } = await admin
    .from("automations")
    .insert([
      timed("at midnight, made before", new Date(Date.now() - 2 * 86_400_000).toISOString()),
      timed("at midnight, made now", new Date().toISOString()),
    ])
    .select("id, name");
  if (timedErr) throw new Error(`could not make the timed rules: ${timedErr.message}`);
  await admin.rpc("abo_code_schedule");
  const { data: timedJobs } = await admin
    .from("code_jobs")
    .select("automation_id")
    .eq("kind", "schedule")
    .in(
      "automation_id",
      timedRules.map((r) => r.id)
    );
  const queuedFor = new Set((timedJobs ?? []).map((j) => j.automation_id));
  const timedId = (n) => timedRules.find((r) => r.name === n).id;
  check("the code clock queues a rule whose time has come", queuedFor.has(timedId("at midnight, made before")));
  check("and not one made since, which waits for the next", !queuedFor.has(timedId("at midnight, made now")));
  await admin
    .from("automations")
    .delete()
    .in(
      "id",
      timedRules.map((r) => r.id)
    );

  // A rule's own code says when it runs next (0138): kept in the store's
  // time, only with the project's ticket, never sooner than five minutes.
  console.log("\na rule's code says when it runs next");
  const { data: lineRow } = await admin
    .from("automations")
    .select("id")
    .eq("project_id", project.id)
    .eq("name", "a line a day")
    .single();
  const lineRule = lineRow.id;
  await admin.from("code_jobs").delete().eq("automation_id", lineRule).in("status", ["queued", "running"]);
  const { data: nextTicket } = await admin.rpc("abo_code_mint", { p_project: project.id });
  const tn = ticketed(nextTicket);
  const nextOf = async () =>
    (await admin.from("automations").select("next_run_at").eq("id", lineRule).single()).data?.next_run_at ?? null;
  const kept = (await tn.rpc("abo_code_next", { p_rule: lineRule, p_at: "2027-01-05T07:00" })).data;
  check(
    "the moment it names is kept, in the store's time",
    kept === true && Date.parse(await nextOf()) === Date.parse("2027-01-05T01:30:00Z")
  );
  const past = (await tn.rpc("abo_code_next", { p_rule: lineRule, p_at: "2020-01-01T00:00" })).data;
  check(
    "a moment gone by waits five minutes, so it never runs every tick",
    past === true && Date.parse(await nextOf()) >= Date.now() + 4 * 60_000
  );
  const stranger = (await ticketed("f".repeat(64)).rpc("abo_code_next", { p_rule: lineRule, p_at: "2027-01-05T07:00" }))
    .data;
  check("and nobody without the project's ticket can move it", stranger === false);
  await admin.from("code_leases").delete().eq("project_id", project.id);
  await admin
    .from("automations")
    .update({ next_run_at: new Date(Date.now() + 3_600_000).toISOString() })
    .eq("id", lineRule);
  await admin.rpc("abo_code_schedule");
  const openFor = async () =>
    (
      await admin
        .from("code_jobs")
        .select("id")
        .eq("automation_id", lineRule)
        .eq("kind", "schedule")
        .eq("status", "queued")
    ).data ?? [];
  check("the clock waits for the moment the code named", (await openFor()).length === 0);
  await admin
    .from("automations")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", lineRule);
  await admin.rpc("abo_code_schedule");
  check(
    "and queues it once it comes, leaving when next to that run",
    (await openFor()).length === 1 && (await nextOf()) === null
  );
  await admin.from("code_jobs").delete().eq("automation_id", lineRule).eq("status", "queued");
} finally {
  await project.remove();
  await other.remove();
}

console.log(
  fails.length === 0
    ? "\na rule's own code runs with nobody watching, for one project at a time"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
