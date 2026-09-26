// The merchant's own fields on the store's rows (0128).
//
// A section over the store's orders could show Shopify's columns and
// nothing of the merchant's, so a design for packing orders built a
// second list of orders to fill in by hand. Now a store section may
// carry fields of the merchant's: a record of the section pointing at
// the row by its id, which no import touches. This checks every door
// such a field can come through, and that nothing else comes through
// them: the records route, the database's own guard, a re-import, a
// rule, and a stranger.
//
// On a throwaway store with the seeded shop in it, through the app on
// APP_URL (no model is called).
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-own-fields.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedNodes, seedShop } from "./fixtures/seed-shop.ts";
import { SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";
import { STORE_TABLES, canCarryOwnFields, ownColumns, withOwnFields } from "../src/lib/store-read.ts";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1, and this writes; nothing checked`);
  process.exit(0);
}
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("which lists can carry them is read from the registry");
for (const [table, spec] of Object.entries(STORE_TABLES)) {
  const hasId = spec.select.split(",").some((c) => c.trim() === "id");
  check(`${table} ${hasId ? "can" : "cannot"}`, canCarryOwnFields(table) === hasId);
}
check("a list that groups rows cannot", !canCarryOwnFields("return_reasons"));
const storeCol = STORE_TABLES.orders.columns[0];
const cols = [
  storeCol,
  { field: "packed", label: "Packed", type: "boolean" },
  { field: "packed_at", label: "Packed at", type: "text" },
  { field: "double", label: "Double", type: "number", compute: { op: "round", args: [{ const: 2 }] } },
];
const mine = ownColumns("orders", cols).map((c) => c.field);
check("the merchant's are neither the store's nor worked out", mine.join() === "packed,packed_at");

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anonKey), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const token = me.session.access_token;
const owner = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "own fields");
const other = await throwawayProject(admin, me.user.id, "own fields other");

const post = (body) =>
  fetch(`${APP}/api/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId: project.id, ...body }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const stamp = Date.now().toString(36);
async function section(projectId, name, source_table, columns) {
  const { data: mod, error } = await admin
    .from("modules")
    .insert({
      project_id: projectId,
      name: `${name}-${stamp}`,
      nav_label: name,
      route: `/${name}-${stamp}`,
      source_table,
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make ${name}: ${error.message}`);
  const { error: e2 } = await admin
    .from("ui_schemas")
    .insert({ module_id: mod.id, version: 1, schema_json: { columns } });
  if (e2) throw new Error(`could not give ${name} its fields: ${e2.message}`);
  return mod.id;
}

async function makeStore(p, label) {
  const { data, error } = await admin
    .from("stores")
    .insert({
      project_id: p.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `${label}-${p.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, data.id);
  return data;
}

try {
  const store = await makeStore(project, "own");
  const theirs = await makeStore(other, "theirs");

  const orders = await section(project.id, "packing", "orders", cols);
  const reasons = await section(project.id, "reasons", "return_reasons", [
    STORE_TABLES.return_reasons.columns[0],
    { field: "note", label: "Note", type: "text" },
  ]);
  const bare = await section(project.id, "bare", "orders", [storeCol]);
  const ownList = await section(project.id, "list", null, [{ field: "note", label: "Note", type: "text" }]);

  const { data: rows } = await admin.from("orders").select("id").eq("store_id", store.id).limit(2);
  const [row, row2] = rows;
  const { data: foreignRows } = await admin.from("orders").select("id").eq("store_id", theirs.id).limit(1);

  console.log("\nkept beside a row, then merged");
  const first = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: row.id,
    data: { packed: true },
  });
  check("the first field makes the row's record", first.status === 200 && first.json?.record?.store_row_id === row.id);
  const recordId = first.json?.record?.id;
  const second = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: row.id,
    data: { packed_at: "shelf 2", [storeCol.field]: "not the store's", double: 99, stray: 1 },
  });
  check("the next one merges into it", !!recordId && second.json?.record?.id === recordId);
  const kept = second.json?.record?.data ?? {};
  check("both fields are kept", kept.packed === true && kept.packed_at === "shelf 2");
  check("a store column is not written", !(storeCol.field in kept));
  check("nor a worked-out one, nor one the section lacks", !("double" in kept) && !("stray" in kept));
  const { count } = await admin
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("module_id", orders)
    .eq("store_row_id", row.id);
  check("one record per row", count === 1);

  console.log("\nwhat is refused");
  const only = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: row2.id,
    data: { [storeCol.field]: "x" },
  });
  check("only the store's fields: nothing to keep", only.status === 400 && /Nothing to keep/.test(only.json?.error));
  const foreign = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: foreignRows[0].id,
    data: { packed: true },
  });
  check("a row of another store is not found", foreign.status === 404);
  const random = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: crypto.randomUUID(),
    data: { packed: true },
  });
  check("nor a row that does not exist", random.status === 404);
  const junk = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: "1; drop",
    data: { packed: true },
  });
  check("an id that is not one is refused", junk.status === 400);
  const create = await post({ action: "create", moduleId: orders, data: { packed: true } });
  check("no row is added to a store section", create.status === 400);
  const del = await post({ action: "delete", moduleId: orders, recordId });
  check("nor taken from it", del.status === 400);
  const onOwn = await post({ action: "update_store_row", moduleId: ownList, storeRowId: row.id, data: { note: "x" } });
  check("an own section has no store rows", onOwn.status === 400);
  const grouped = await post({
    action: "update_store_row",
    moduleId: reasons,
    storeRowId: row.id,
    data: { note: "x" },
  });
  check("a list that groups rows keeps none", grouped.status === 400);
  const noOwn = await post({ action: "update_store_row", moduleId: bare, storeRowId: row.id, data: { packed: true } });
  check("a section with no fields of its own keeps none", noOwn.status === 400);

  console.log("\nthe database holds the line whoever writes");
  const loose = await admin
    .from("records")
    .insert({ project_id: project.id, module_id: orders, data: { packed: true } });
  check("a store section's record names a row", loose.error?.code === "23514");
  const stray = await admin
    .from("records")
    .insert({ project_id: project.id, module_id: ownList, store_row_id: row.id, data: { note: "x" } });
  check("an own section's never does", stray.error?.code === "23514");
  const twin = await admin
    .from("records")
    .insert({ project_id: project.id, module_id: orders, store_row_id: row.id, data: { packed: false } });
  check("a second record for the same row is refused", twin.error?.code === "23505");
  const moved = await admin.from("records").update({ module_id: ownList }).eq("id", recordId);
  check("nor can a record be moved into an own section", moved.error?.code === "23514");

  console.log("\nan import leaves them alone");
  await SHOPIFY_RESOURCES.orders.save(admin, store.id, seedNodes().orders);
  const { data: same } = await admin.from("orders").select("id").eq("id", row.id).maybeSingle();
  check("the row keeps its id", same?.id === row.id);
  const { data: after } = await admin.from("records").select("data").eq("id", recordId).single();
  check(
    "and the fields beside it are as they were",
    after?.data?.packed === true && after?.data?.packed_at === "shelf 2"
  );

  console.log("\nlaid over the store's rows");
  const laid = await withOwnFields(owner, orders, [
    { id: row.id, data: { [storeCol.field]: "the store's" } },
    { id: row2.id, data: { [storeCol.field]: "untouched" } },
    { id: "not-a-uuid", data: {} },
  ]);
  check("a row gets its fields", laid[0].data.packed === true && laid[0].data.packed_at === "shelf 2");
  check("a row without any is as it was", Object.keys(laid[1].data).join() === storeCol.field);
  check("an id that is not one is passed over", laid.length === 3 && Object.keys(laid[2].data).length === 0);
  await admin
    .from("records")
    .update({ data: { ...after.data, [storeCol.field]: "a pretender" } })
    .eq("id", recordId);
  const clash = await withOwnFields(owner, orders, [{ id: row.id, data: { [storeCol.field]: "the store's" } }]);
  check("the store's value wins a shared name", clash[0].data[storeCol.field] === "the store's");

  console.log("\nstats count what the section shows");
  // The pretender above is gone again, so the row reads as it was kept.
  await admin.from("records").update({ data: after.data }).eq("id", recordId);
  const packedWhere = { op: "=", args: [{ field: "packed" }, { const: true }] };
  const stats = async () =>
    (
      await owner.rpc("abo_section_stats", {
        p_module: orders,
        p_stats: [{ op: "count" }, { op: "count", where: packedWhere }],
        p_scope: {},
      })
    ).data;
  const { count: storeOrders } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store.id);
  const [all, packed] = (await stats()) ?? [];
  check("every order is counted once", all?.count === storeOrders);
  check("and a stat over a field of the merchant's reads it", packed?.count === 1);
  await admin.from("modules").update({ source_table: null }).eq("id", orders);
  const [asOwn] = (await stats()) ?? [];
  check("pointed back at its own rows, the fields beside store rows are not rows", asOwn?.count === 0);
  await admin.from("modules").update({ source_table: "orders" }).eq("id", orders);

  console.log("\na rule runs on them as on any record");
  const { error: ruleErr } = await admin
    .from("automations")
    .insert({
      project_id: project.id,
      module_id: orders,
      name: "note unpacked",
      definition: {
        trigger: { type: "record_updated", when: { op: "=", args: [{ field: "packed" }, { const: false }] } },
        actions: [{ type: "set_fields", target: { self: true }, set: { packed_at: { const: "unpacked" } } }],
      },
    })
    .select("id")
    .single();
  if (ruleErr) throw new Error(`could not make the rule: ${ruleErr.message}`);
  await post({ action: "update_store_row", moduleId: orders, storeRowId: row.id, data: { packed: false } });
  const { data: ruled } = await admin.from("records").select("data").eq("id", recordId).single();
  check("its rule fired", ruled?.data?.packed_at === "unpacked");
  // The first field kept on a row is a change to a row already there:
  // a rule "when packed" fires on the first tick, and one "when a row is
  // added" never does, because nobody added the order here.
  const { error: e3 } = await admin.from("automations").insert([
    {
      project_id: project.id,
      module_id: orders,
      name: "stamp packed",
      definition: {
        trigger: { type: "record_updated", when: packedWhere },
        actions: [{ type: "set_fields", target: { self: true }, set: { packed_at: { const: "stamped" } } }],
      },
    },
    {
      project_id: project.id,
      module_id: orders,
      name: "a row was added",
      definition: {
        trigger: { type: "record_created" },
        actions: [{ type: "set_fields", target: { self: true }, set: { packed: { const: false } } }],
      },
    },
  ]);
  if (e3) throw new Error(`could not make the rules: ${e3.message}`);
  const firstTick = await post({
    action: "update_store_row",
    moduleId: orders,
    storeRowId: row2.id,
    data: { packed: true },
  });
  const { data: ticked } = await admin.from("records").select("data").eq("id", firstTick.json?.record?.id).single();
  check("a rule on a change fires on a row's first field", ticked?.data?.packed_at === "stamped");
  check("and one on a row being added does not", ticked?.data?.packed === true);

  console.log("\na stranger sees nothing");
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: peek } = await anon.from("records").select("id").eq("module_id", orders);
  check("not the fields", (peek ?? []).length === 0);
  const stranger = await fetch(`${APP}/api/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update_store_row",
      projectId: project.id,
      moduleId: orders,
      storeRowId: row.id,
      data: { packed: true },
    }),
  });
  check("nor write them", stranger.status === 401);
} finally {
  await project.remove();
  await other.remove();
}

console.log(
  fails.length === 0
    ? "\nthe merchant's fields sit beside the store's rows, and only there"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
