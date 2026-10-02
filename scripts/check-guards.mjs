// A rule that says no, asked of the database with two people at once.
//
// Until 0143 every rule ran after the save, so the most one could do about
// two people holding the last unit was to flag it once both holds existed.
// A before_save rule refuses the second — and only a real race shows that:
// one connection holds the last unit inside a transaction it keeps open,
// and a second person saves the same hold through the app's own door
// meanwhile. The second must wait, then be refused. With the rule switched
// off the same race keeps both, which is how it stood before.
//
// Also: a slot taken once is refused the second time; a released hold
// frees its unit; a change that would hold more than there is is refused
// and leaves the row as it was; and a rule's own action is held to the
// same line as a person.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-guards.mjs

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { seedShop } from "./fixtures/seed-shop.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this makes accounts, stores and rules of its own, so it runs only there");
  process.exit(0);
}
if (!env.DATABASE_URL) {
  console.log("needs DATABASE_URL: the race is one transaction held open on a connection of its own");
  process.exit(0);
}
const BASE = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
const admin = createClient(BASE, SVC);

const rest =
  (jwt) =>
  async (path, init = {}) => {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...init.headers,
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, json: body ? JSON.parse(body) : null };
  };

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** One statement list run in a transaction of its own, over psql. Resolves when it has committed. */
const held = (sql) =>
  new Promise((resolve, reject) => {
    const p = spawn("psql", [env.DATABASE_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 300)))));
  });

/** One question over psql, its answer as text. */
const ask = (sql) =>
  new Promise((resolve, reject) => {
    const p = spawn("psql", [env.DATABASE_URL, "-X", "-A", "-t", "-c", sql], {
      env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 300)))));
  });

/**
 * Until the transaction tagged `tag` is asleep, which is after its insert:
 * the row is in and the rule's lock is held. Waiting a fixed second was a
 * guess, and from CI, a long way from the database, psql had not even
 * connected by then, so the second save got there first.
 */
async function asleep(tag) {
  for (let i = 0; i < 150; i++) {
    const n = await ask(
      `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%${tag}%' and pid <> pg_backend_pid()`
    );
    if (n === "1") return;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`${tag} never got as far as holding`);
}

const stamp = Date.now();
const signed = await fetch(`${BASE}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: `guards-${stamp}@warmluke.test`, password: "Test-passw0rd!" }),
}).then((x) => x.json());
if (!signed.access_token) throw new Error(`signup failed: ${JSON.stringify(signed).slice(0, 200)}`);
const owner = { jwt: signed.access_token, id: signed.user.id };
const O = rest(owner.jwt);

try {
  const [proj] = (await O("projects", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: "Guards" }) }))
    .json;
  const section = async (name) =>
    (
      await O("modules", {
        method: "POST",
        body: JSON.stringify({
          project_id: proj.id,
          name: `${name}_${stamp}`,
          nav_label: name,
          route: `/${name}_${stamp}`,
        }),
      })
    ).json[0];
  const rule = async (module, name, definition, enabled = true) =>
    (
      await O("automations", {
        method: "POST",
        body: JSON.stringify({ project_id: proj.id, module_id: module.id, name, definition, enabled }),
      })
    ).json[0];
  const add = (module, data) =>
    O("records", { method: "POST", body: JSON.stringify({ project_id: proj.id, module_id: module.id, data }) });

  console.log("a slot can be taken once");
  const slots = await section("slots");
  await rule(slots, "One booking a slot", {
    trigger: {
      type: "before_save",
      when: { op: ">=", args: [{ op: "count_matching", args: [{ field: "slot" }] }, { const: 1 }] },
    },
    actions: [{ type: "refuse", message: "That slot is already taken." }],
  });
  check("the first booking is saved", (await add(slots, { slot: "10:00", who: "Aman" })).ok);
  const second = await add(slots, { slot: "10:00", who: "Riya" });
  check("the second is refused", !second.ok);
  check("in the rule's own words", second.json?.message === "That slot is already taken.");
  check("another slot is fine", (await add(slots, { slot: "11:00", who: "Riya" })).ok);

  console.log("\nthe last unit, with two people at once");
  const { data: store, error: storeError } = await admin
    .from("stores")
    .insert({
      project_id: proj.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `guards-${stamp}.myshopify.com`,
      access_token: "guards-token-opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      connected_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (storeError) throw new Error(`store: ${storeError.message}`);
  await seedShop(admin, store.id);
  const { data: line } = await admin
    .from("store_inventory")
    .select("id, inventory_item_id, location_id")
    .eq("store_id", store.id)
    .not("inventory_item_id", "is", null)
    .limit(1)
    .single();
  await admin.from("inventory_levels").update({ available: 1 }).eq("id", line.id);
  check(
    "one unit of it can be sold",
    (await admin.from("store_inventory").select("available").eq("id", line.id).single()).data?.available === 1
  );

  const holds = await section("holds");
  const notMoreThanThere = {
    trigger: {
      type: "before_save",
      when: {
        op: ">",
        args: [
          {
            op: "+",
            args: [
              {
                op: "sum_matching",
                args: [
                  { field: "qty" },
                  { field: "item" },
                  { field: "place" },
                  { op: "!=", args: [{ field: "status" }, { const: "Released" }] },
                ],
              },
              { field: "qty" },
            ],
          },
          {
            op: "store_value",
            args: [
              { const: "inventory_levels" },
              { const: "available" },
              { const: "inventory_item_id" },
              { field: "item" },
              { const: "location_id" },
              { field: "place" },
            ],
          },
        ],
      },
    },
    actions: [{ type: "refuse", message: "Not enough left to hold that many." }],
  };
  const guard = await rule(holds, "No more held than can be sold", notMoreThanThere);
  const hold = (who, qty = 1) => ({ item: line.inventory_item_id, place: line.location_id, qty, status: "Held", who });
  const holdSql = (who, tag) =>
    `/* ${tag} */ begin; insert into public.records (project_id, module_id, data) values ('${proj.id}', '${holds.id}', '${JSON.stringify(hold(who))}'::jsonb); select pg_sleep(6); commit;`;

  // Meera's hold, saved and kept open six seconds; Arjun's, through the
  // app's own door, once hers is in. Six, not three: from a runner far
  // from the database each look for her sleeping session is a new
  // connection of a second or two, so with three the look could land so
  // late that Arjun waited less than the bar below, and the check failed
  // with the guard working (two runs in three on 2026-10-02).
  const meera = held(holdSql("Meera", `hold-${stamp}-1`));
  await asleep(`hold-${stamp}-1`);
  const t0 = Date.now();
  const arjun = await add(holds, hold("Arjun"));
  const waited = Date.now() - t0;
  await meera;
  check("the second waited for the first to finish", waited >= 1200);
  check("and was then refused", !arjun.ok && arjun.json?.message === "Not enough left to hold that many.");
  const { count: kept } = await admin
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("module_id", holds.id);
  check("one hold is kept, not two", kept === 1);

  console.log("\nthe same race with the rule off keeps both, as it stood before");
  await admin.from("records").delete().eq("module_id", holds.id);
  await admin.from("automations").update({ enabled: false }).eq("id", guard.id);
  const again = held(holdSql("Meera", `hold-${stamp}-2`));
  await asleep(`hold-${stamp}-2`);
  const unguarded = await add(holds, hold("Arjun"));
  await again;
  const { count: both } = await admin
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("module_id", holds.id);
  check("both saved: the last unit held twice", unguarded.ok && both === 2);
  await admin.from("records").delete().eq("module_id", holds.id);
  await admin.from("automations").update({ enabled: true }).eq("id", guard.id);

  console.log("\nholding, releasing, and asking for more than there is");
  const first = await add(holds, hold("Meera"));
  check("a hold on the last unit is kept", first.ok);
  const id = first.json?.[0]?.id;
  const more = await O(`records?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data: hold("Meera", 2) }) });
  check("changing it to two is refused", !more.ok && /Not enough left/.test(more.json?.message ?? ""));
  const { data: still } = await admin.from("records").select("data").eq("id", id).single();
  check("and the hold is as it was", still?.data?.qty === 1);
  check(
    "releasing it is fine",
    (
      await O(`records?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { ...hold("Meera"), status: "Released" } }),
      })
    ).ok
  );
  check("and the unit can be held again", (await add(holds, hold("Arjun"))).ok);

  console.log("\na rule's own action is held to the same line");
  const incoming = await section("incoming");
  await rule(incoming, "Hold one for each order", {
    trigger: { type: "record_created" },
    actions: [
      {
        type: "create_record",
        module_id: holds.id,
        data: {
          item: { const: line.inventory_item_id },
          place: { const: line.location_id },
          qty: { const: 1 },
          status: { const: "Held" },
          who: { const: "the rule" },
        },
      },
    ],
  });
  const order = await add(incoming, { order: "#1001" });
  check("the row that fired it is saved", order.ok);
  const { count: holdsNow } = await admin
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("module_id", holds.id)
    .eq("data->>status", "Held");
  check("but the hold it tried to add is not", holdsNow === 1);
  const { data: runs } = await admin.from("automation_runs").select("ok, detail").eq("record_id", order.json?.[0]?.id);
  check(
    "and the refusal is written down",
    (runs ?? []).some((x) => x.ok === false && /Not enough left/.test(JSON.stringify(x.detail)))
  );
} finally {
  await fetch(`${BASE}/auth/v1/admin/users/${owner.id}`, {
    method: "DELETE",
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
  });
  console.log("\nthe account, its app and its store are removed");
}

console.log(fails.length === 0 ? "\nthe second one is stopped, not flagged" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
