// What goes to the store straight away, and who said so (0195, Tanish,
// 7 Oct). The owner turns one kind of change on for their store, with
// the words they read kept; their own change of that kind, asked from
// the screen, is taken as their yes; anything else waits for it: a
// teammate's, one left a while, a kind still off, and anything their own
// AI asks. Their AI can neither flip the switch nor send a change.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-send.mjs
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
if (env.CHECK_PROJECT !== "1") throw new Error("not the check project's env; this writes");
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, ANON), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const as = (token) =>
  createClient(url, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
const owner = as(me.session.access_token);
// As their own AI would come in: the owner's id with a client_id on the token.
const sql = (query) =>
  fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const asClient = (body) =>
  sql(`begin;
select set_config('request.jwt.claims', $c$${JSON.stringify({ sub: me.user.id, role: "authenticated", client_id: "check-client" })}$c$, true);
set local role authenticated;
${body}
rollback;`);

const project = await throwawayProject(admin, me.user.id, "store send");
const { data: was } = await admin
  .from("account_settings")
  .select("store_actions_enabled")
  .eq("user_id", me.user.id)
  .maybeSingle();
let staff = null;

try {
  // The account may change a store at all (0107): an administrator's switch.
  await admin.from("account_settings").upsert({ user_id: me.user.id, store_actions_enabled: true });
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `send-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const { data: line } = await admin
    .from("store_inventory")
    .select("inventory_item_id, location_id, available")
    .eq("store_id", store.id)
    .limit(1)
    .single();
  const ask = (db) =>
    db.rpc("abo_action_propose", {
      p_project: project.id,
      p_store: store.id,
      p_action: "set_stock",
      p_targets: [{ id: line.inventory_item_id, locationId: line.location_id, quantity: 9, from: line.available }],
      p_params: {},
      p_summary: "Sets the count of one item to 9",
    });
  const statusOf = async (id) =>
    (await admin.from("store_actions").select("status").eq("id", id).single()).data?.status;

  console.log("read as the app reads it");
  // Column by column on this table: a column not granted failed the whole read, and every store list read as empty.
  const { error: readErr } = await owner
    .from("stores")
    .select("id, status, auto_send, granted_scopes")
    .eq("id", store.id);
  check("the owner reads what goes straight, with the rest of the store", !readErr);

  console.log("\noff until the owner turns it on");
  const fresh = await ask(owner);
  check("asked by the owner", !fresh.error && !!fresh.data);
  const off = await owner.rpc("abo_action_send_now", { p_action: fresh.data });
  check("with it off, their change waits", off.data?.approved === false && (await statusOf(fresh.data)) === "pending");

  console.log("\nturned on, with the words they read kept");
  const said = "When you set a stock count on a list in Warmluke, it is sent at once.";
  const empty = await owner.rpc("abo_set_auto_send", {
    p_store: store.id,
    p_action: "set_stock",
    p_on: true,
    p_said: " ",
  });
  check("not on with nothing read", !!empty.error);
  const on = await owner.rpc("abo_set_auto_send", {
    p_store: store.id,
    p_action: "set_stock",
    p_on: true,
    p_said: said,
  });
  check("on for stock counts", !on.error && on.data?.includes("set_stock"));
  await owner.rpc("abo_set_auto_send", { p_store: store.id, p_action: "set_stock", p_on: true, p_said: said });
  const consents = async () =>
    (await owner.from("store_send_consents").select("action, turned_on, said, user_id").eq("store_id", store.id))
      .data ?? [];
  const kept = await consents();
  check(
    "one consent kept, word for word, by them; said again is not a second",
    kept.length === 1 && kept[0].said === said && kept[0].turned_on && kept[0].user_id === me.user.id
  );
  check(
    "the other kinds stay off",
    (await admin.from("stores").select("auto_send").eq("id", store.id).single()).data?.auto_send.join() === "set_stock"
  );

  console.log("\nthe owner's own change, from the screen, goes now");
  const mine = await ask(owner);
  const now = await owner.rpc("abo_action_send_now", { p_action: mine.data });
  check("taken as their yes", now.data?.approved === true && (await statusOf(mine.data)) === "approved");
  check(
    "once: not a second time",
    (await owner.rpc("abo_action_send_now", { p_action: mine.data })).data?.approved === false
  );
  const old = await ask(owner);
  await admin
    .from("store_actions")
    .update({ created_at: new Date(Date.now() - 10 * 60e3).toISOString() })
    .eq("id", old.data);
  check(
    "one left waiting a while is agreed to in the bell, not here",
    (await owner.rpc("abo_action_send_now", { p_action: old.data })).data?.approved === false
  );
  const tag = await owner.rpc("abo_action_propose", {
    p_project: project.id,
    p_store: store.id,
    p_action: "add_tags",
    p_targets: [{ id: "gid://shopify/Order/1" }],
    p_params: { tags: ["rush"] },
    p_summary: "Tags 1 order",
  });
  check(
    "a kind still off waits",
    (await owner.rpc("abo_action_send_now", { p_action: tag.data })).data?.approved === false
  );

  console.log("\na teammate asks; the owner says yes");
  const st = Date.now();
  const mail = `send_member_${st}@example.com`;
  const pw = `pw_${st}_aA1!`;
  ({ data: staff } = await admin.auth.admin.createUser({ email: mail, password: pw, email_confirm: true }));
  await admin.from("project_members").insert({
    project_id: project.id,
    user_id: staff.user.id,
    email: mail,
    joined_at: new Date().toISOString(),
    can_see_store: true,
  });
  const theirSession = (await createClient(url, ANON).auth.signInWithPassword({ email: mail, password: pw })).data;
  const teammate = as(theirSession.session.access_token);
  const theirs = await ask(teammate);
  check("a teammate who can open the store may ask", !theirs.error && !!theirs.data);
  check(
    "but theirs waits, setting on or not",
    (await teammate.rpc("abo_action_send_now", { p_action: theirs.data })).data?.approved === false &&
      (await statusOf(theirs.data)) === "pending"
  );
  check(
    "they read what they asked for",
    ((await teammate.from("store_actions").select("id").eq("id", theirs.data)).data ?? []).length === 1
  );
  check(
    "and not the owner's",
    ((await teammate.from("store_actions").select("id").eq("id", mine.data)).data ?? []).length === 0
  );
  check(
    "they cannot turn it on",
    !!(await teammate.rpc("abo_set_auto_send", { p_store: store.id, p_action: "add_tags", p_on: true, p_said: said }))
      .error
  );
  check(
    "nor approve their own",
    (await teammate.rpc("abo_action_approve", { p_action: theirs.data })).data?.approved === false
  );
  check("the owner can", (await owner.rpc("abo_action_approve", { p_action: theirs.data })).data?.approved === true);

  console.log("\ntheir own AI can do neither");
  if (env.SUPABASE_ACCESS_TOKEN) {
    const flip = await asClient(`select public.abo_set_auto_send('${store.id}', 'add_tags', true, 'yes');`);
    check("it cannot flip the switch", flip.status >= 400 && /Only the owner/.test(JSON.stringify(flip.body)));
    const aiAsk = await asClient(`select public.abo_action_send_now(public.abo_action_propose(
      '${project.id}', '${store.id}', 'set_stock',
      '[{"id": "${line.inventory_item_id}", "locationId": "${line.location_id}", "quantity": 9}]'::jsonb, '{}'::jsonb,
      'Sets the count of one item to 9')) as said;`);
    check(
      "and what it asks for waits, with stock counts on",
      JSON.stringify(aiAsk.body).includes('"approved": false') ||
        JSON.stringify(aiAsk.body).includes('"approved":false')
    );
  } else {
    console.log("  (skipped: no SUPABASE_ACCESS_TOKEN to come in as a client)");
  }

  console.log("\nturned off, and that kept too");
  const offAgain = await owner.rpc("abo_set_auto_send", {
    p_store: store.id,
    p_action: "set_stock",
    p_on: false,
    p_said: "",
  });
  check("off", !offAgain.error && !offAgain.data?.includes("set_stock"));
  const after = await consents();
  check("the off is kept beside the on", after.length === 2 && after.some((c) => !c.turned_on));
  const later = await ask(owner);
  check(
    "and their change waits again",
    (await owner.rpc("abo_action_send_now", { p_action: later.data })).data?.approved === false
  );
} finally {
  if (staff?.user) await admin.auth.admin.deleteUser(staff.user.id);
  await admin
    .from("account_settings")
    .upsert({ user_id: me.user.id, store_actions_enabled: was?.store_actions_enabled ?? false });
  await project.remove();
}

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nwhat goes straight to the store is the owner's to say, and kept"
);
process.exit(fails.length ? 1 : 0);
