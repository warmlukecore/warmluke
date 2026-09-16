// Rows we hold that Shopify no longer has.
//
// Webhooks are how the store stays current, and a delete that is never
// delivered leaves a row here for good. Reconciliation only upserts,
// so walking Shopify again does not remove it either — the app simply
// goes on showing a product the merchant deleted last week.
//
// A pass has just read the whole of Shopify, so what it imported IS
// Shopify's count: the gap needs no second API call to find.
//
// It is reported and never acted on. A page that failed quietly, or a
// bulk file that came back short, looks exactly like a deletion, and a
// wrong delete does not come back. Ending the silence is the fix; the
// sweep would be a worse problem wearing its clothes.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-drift.mjs

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
const { data: store } = await admin
  .from("stores")
  .select("id, project_id")
  .eq("status", "connected")
  .limit(1)
  .maybeSingle();
if (!store) {
  console.log("no connected store — nothing to check");
  process.exit(0);
}

const ask = () =>
  fetch(`${APP}/api/shopify/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner.session.access_token}`,
    },
    body: JSON.stringify({ projectId: store.project_id }),
  }).then((r) => r.json());

const rowsOf = async (table) =>
  (await admin.from(table).select("id", { count: "exact", head: true }).eq("store_id", store.id))
    .count ?? 0;

const { data: runsBefore } = await admin
  .from("import_runs")
  .select("id, resource, status, cursor, imported, finished_at")
  .eq("store_id", store.id);

try {
  const products = await rowsOf("products");
  const customers = await rowsOf("customers");

  const finished = "2026-01-02T03:04:05+00:00";
  const set = async (resource, imported) => {
    const run = (runsBefore ?? []).find((r) => r.resource === resource);
    if (run) {
      await admin
        .from("import_runs")
        .update({ status: "done", cursor: null, imported, finished_at: finished })
        .eq("id", run.id);
    }
  };

  // A finished pass that agrees with what is here.
  for (const r of runsBefore ?? []) {
    await admin
      .from("import_runs")
      .update({ status: "done", cursor: null, finished_at: finished })
      .eq("id", r.id);
  }
  await set("products", products);
  await set("customers", customers);
  await set("orders", await rowsOf("orders"));

  console.log("a pass that brought back everything we hold");
  const agreed = await ask();
  check("says it is done", agreed.done === true);
  check("and reports no drift at all", agreed.drift === undefined);
  check("nor a warning about it", agreed.drift_note === undefined);

  console.log("\nand a pass that came back two products short");
  // What a delete webhook that never arrived leaves behind.
  await set("products", products - 2);
  const short = await ask();
  check("the gap is named", short.drift?.products?.holding === products);
  check("against what the pass brought", short.drift?.products?.imported === products - 2);
  check("and it is said plainly", /removed there/i.test(short.drift_note ?? ""));
  check("a resource that agrees is not mentioned", short.drift?.customers === undefined);

  // Stock is never compared this way. A pass counts variants and the
  // table holds levels, so a store with two locations would be told
  // for ever that rows had gone missing — which is what happened.
  await set("inventory", 1);
  const stock = await ask();
  check("and stock is never counted this way at all", stock.drift?.inventory === undefined);

  // More here than the pass brought is a loss. Fewer is a webhook that
  // landed mid-pass, and must not read as one.
  await set("products", products + 5);
  const ahead = await ask();
  check("a pass that brought back more is not a loss", ahead.drift?.products === undefined);

  // The whole point of reporting rather than sweeping.
  check("and nothing was deleted", (await rowsOf("products")) === products);
} finally {
  for (const r of runsBefore ?? []) {
    await admin
      .from("import_runs")
      .update({
        status: r.status,
        cursor: r.cursor,
        imported: r.imported,
        finished_at: r.finished_at,
      })
      .eq("id", r.id);
  }
  const back = await admin
    .from("import_runs")
    .select("resource, imported, status")
    .eq("store_id", store.id);
  check(
    "the import history is back as it was",
    (back.data ?? []).every((r) => {
      const was = (runsBefore ?? []).find((x) => x.resource === r.resource);
      return was && was.imported === r.imported && was.status === r.status;
    })
  );
}

console.log(
  fails.length === 0 ? "\nwhat is missing is said, not swept" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
