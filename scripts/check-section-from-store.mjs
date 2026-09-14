// Creating a section that is already pointed at the store.
//
// Runs against the running app as a throwaway owner, because what is
// worth checking is the route's own refusals — a section pointed at a
// table that is not a store table, or at a store the caller has none
// of. The test user is removed at the end and takes its rows with it.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-section-from-store.mjs
//   APP_URL=https://warmluke.vercel.app node ... (to check the deployed one)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { STORE_TABLES } from "../src/lib/store-read.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const stamp = Date.now();
const email = `sec_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made, error: uErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (uErr) throw new Error(uErr.message);

const anon = createClient(URL_, ANON);
const { data: session, error: sErr } = await anon.auth.signInWithPassword({ email, password });
if (sErr) throw new Error(sErr.message);
const token = session.session.access_token;

const post = (body) =>
  fetch(`${APP}/api/modules`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

const { data: proj } = await anon
  .from("projects")
  .insert({ name: `sec test ${stamp}` })
  .select()
  .single();

try {
  console.log("a project with no store cannot point a section at one");
  const noStore = await post({ projectId: proj.id, nav_label: "Orders", source_table: "orders" });
  check("it is refused with 409, not created empty", noStore.status === 409);
  check("and it says why", /store is connected/i.test(noStore.json.error ?? ""));

  console.log("\nthe table name is not taken on trust");
  for (const bad of ["records", "projects", "stores", "orders; drop table x"]) {
    const r = await post({ projectId: proj.id, nav_label: "X", source_table: bad });
    check(`${JSON.stringify(bad)} is refused`, r.status === 400);
  }

  // Give this project a store so the happy path can run.
  await admin.from("stores").insert({
    project_id: proj.id,
    shop_domain: `sec-${stamp}.myshopify.com`,
    status: "connected",
    timezone: "Asia/Kolkata",
    currency: "INR",
  });

  console.log("\nwith a store connected");
  const ok = await post({ projectId: proj.id, nav_label: "Orders", source_table: "orders" });
  check("the section is created", ok.status === 200 && !!ok.json.module?.id);
  check("and it is pointed at the store", ok.json.module?.source_table === "orders");

  const { data: schema } = await anon
    .from("ui_schemas")
    .select("schema_json, version")
    .eq("module_id", ok.json.module.id)
    .single();
  const got = (schema?.schema_json?.columns ?? []).map((c) => c.field);
  const want = STORE_TABLES.orders.columns.map((c) => c.field);
  check("its columns are the store's, not a default one", got.join(",") === want.join(","));

  // The trap: a caller sending both must not end up with a section
  // whose columns describe one thing and whose rows are another.
  const both = await post({
    projectId: proj.id,
    nav_label: "Customers",
    source_table: "customers",
    fields: [{ label: "Totally Unrelated", type: "text" }],
  });
  const { data: s2 } = await anon
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", both.json.module.id)
    .single();
  const fields2 = (s2?.schema_json?.columns ?? []).map((c) => c.field);
  check(
    "sent fields are ignored when a store table is named",
    !fields2.includes("totally_unrelated") &&
      fields2.join(",") === STORE_TABLES.customers.columns.map((c) => c.field).join(",")
  );

  console.log("\nan ordinary section still works");
  const plain = await post({
    projectId: proj.id,
    nav_label: "My notes",
    fields: [{ label: "Note", type: "text" }],
  });
  check("it is created", plain.status === 200);
  check("with no source", plain.json.module?.source_table === null);
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest user removed");
}

console.log(
  fails.length === 0 ? "\nstore sections are created honestly" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
