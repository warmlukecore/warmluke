// Whether "synced" is a fact or a timestamp.
//
// Webhooks keep the store current, and a webhook that never arrives is
// missed in silence — a subscription that failed to register, an
// outage, a topic Shopify switched off after too many failures. The
// importer noticed none of it: once every resource was marked done it
// stopped reading Shopify altogether and only moved last_synced_at
// forward, so the app reported a fresh sync at the moment of asking
// having read nothing at all.
//
// This checks the two halves of the honest version: the timestamp says
// when a pass really finished, and there is a way to walk Shopify
// again.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-recheck.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
  .select("id, project_id, last_synced_at")
  .eq("status", "connected")
  .limit(1)
  .maybeSingle();
if (!store) {
  console.log("no connected store — nothing to check");
  process.exit(0);
}

const importCall = (body) =>
  fetch(`${APP}/api/shopify/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner.session.access_token}`,
    },
    body: JSON.stringify({ projectId: store.project_id, ...body }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// Everything here is put back: this is a real store with a real import.
const { data: runsBefore } = await admin
  .from("import_runs")
  .select("id, resource, status, cursor, imported, finished_at")
  .eq("store_id", store.id);
const syncedBefore = store.last_synced_at;

try {
  // A store that has finished importing, with a known finish time.
  const finished = "2026-01-02T03:04:05+00:00";
  for (const r of runsBefore ?? []) {
    await admin
      .from("import_runs")
      .update({ status: "done", cursor: null, finished_at: finished })
      .eq("id", r.id);
  }
  await admin
    .from("stores")
    .update({ last_synced_at: "2020-01-01T00:00:00+00:00" })
    .eq("id", store.id);

  console.log("asking a store that has already finished");
  const done = await importCall({});
  check("it says there is nothing left to walk", done.body?.done === true);
  // The whole point. This used to be now(), so the app claimed a fresh
  // sync for a request that read nothing from Shopify.
  const after = (
    await admin.from("stores").select("last_synced_at").eq("id", store.id).single()
  ).data;
  check(
    "and dates the sync from when it really finished",
    new Date(after.last_synced_at).getTime() === new Date(finished).getTime()
  );
  check(
    "not from the moment of asking",
    new Date(after.last_synced_at).getTime() < Date.now() - 60000
  );
  check("it says how to look again", /recheck/i.test(done.body?.note ?? ""));

  console.log("\nand asked to look again");
  const again = await importCall({ recheck: true });
  check("it starts over rather than refusing", again.body?.rechecking === true);
  check("and is no longer done", again.body?.done === false);

  const reset = await admin
    .from("import_runs")
    .select("status, cursor, finished_at")
    .eq("store_id", store.id);
  check(
    "every resource is waiting to be walked",
    (reset.data ?? []).every((r) => r.status === "pending" && r.cursor === null)
  );
  check(
    "and none of them still claims to have finished",
    (reset.data ?? []).every((r) => r.finished_at === null)
  );

  // Asking a store with no import history to recheck is not an error —
  // it is just the first import.
  console.log("\nand a store that never imported");
  await admin.from("import_runs").delete().eq("store_id", store.id);
  const fresh = await importCall({ recheck: true });
  check("is simply imported, not rechecked", fresh.body?.rechecking !== true);
} finally {
  await admin.from("import_runs").delete().eq("store_id", store.id);
  for (const r of runsBefore ?? []) {
    await admin.from("import_runs").insert({
      id: r.id,
      store_id: store.id,
      resource: r.resource,
      status: r.status,
      cursor: r.cursor,
      imported: r.imported,
      finished_at: r.finished_at,
    });
  }
  await admin.from("stores").update({ last_synced_at: syncedBefore }).eq("id", store.id);
  const back = (
    await admin.from("stores").select("last_synced_at").eq("id", store.id).single()
  ).data;
  check("the store is back as it was", back.last_synced_at === syncedBefore);
  const rows = await admin
    .from("import_runs")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store.id);
  check("with its import history intact", (rows.count ?? 0) === (runsBefore ?? []).length);
}

console.log(fails.length === 0 ? "\nsynced means it looked" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
