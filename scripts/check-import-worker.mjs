// The import ticket, tried the way somebody would try to misuse it.
//
// The background worker holds no key. Its authority is a ticket the
// database mints for one store, sends only to the worker, and keeps
// only the hash of. Everything that makes that safe is a policy or a
// function in 0110 — so this does not trust the migration's comments;
// it presents tickets and sees what the database lets through: the
// right store and nothing else, never another store, never after the
// ticket lapses, never with a guessed one, and never beyond the
// importer's own tables.
//
// Then the route: a job it cannot prove is refused before any work is
// scheduled, and a real one runs, records what went wrong (the store
// here is made up, so Shopify refuses it), and gives its ticket back.
//
//   ENV_FILE=.env.check.local APP_URL=http://127.0.0.1:3102 \
//     node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-import-worker.mjs

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { RESOURCES } from "../src/lib/shopify-resources.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const withTicket = (t) =>
  createClient(URL_, ANON, { global: { headers: { "x-import-ticket": t } }, auth: { persistSession: false } });
const nobody = createClient(URL_, ANON, { auth: { persistSession: false } });

// The check project must have no worker address, or the stores this
// run makes would be sent to a server it does not control. Asked about
// a store that does not exist, so the answer costs nothing either way.
const { data: configured } = await admin.rpc("abo_import_dispatch", {
  p_store: "00000000-0000-0000-0000-000000000000",
});
if (configured !== "not_configured") {
  console.log(`this project has a worker address (dispatch said ${JSON.stringify(configured)}); refusing to run here`);
  process.exit(1);
}

const owner = createClient(URL_, ANON);
const me = await signInAsCheckUser(owner, env);
if (!me.session) {
  console.log(`could not sign in as the check user — ${me.why}`);
  process.exit(1);
}
const mine = await throwawayProject(admin, me.user.id, "import-worker");
const theirs = await throwawayProject(admin, me.user.id, "import-worker-other");
// Somebody else entirely, for "not yours".
const { data: made } = await admin.auth.admin.createUser({
  email: `stranger-${Date.now().toString(36)}@warmluke.test`,
  email_confirm: true,
});
const stranger = made?.user?.id;
const { data: strangerProject } = await admin
  .from("projects")
  .insert({ owner_id: stranger, name: "check import-worker-stranger" })
  .select("id")
  .single();

const tag = Date.now().toString(36);
const newStore = async (projectId, name) => {
  const { data, error } = await admin
    .from("stores")
    .insert({
      project_id: projectId,
      provider: "shopify",
      shop_domain: `${name}-${tag}.myshopify.com`,
      status: "connected",
      access_token: `fake-token-${name}`,
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make a store: ${error.message}`);
  return data.id;
};

try {
  const A = await newStore(mine.id, "wl-worker-a");
  const B = await newStore(theirs.id, "wl-worker-b");
  const S = await newStore(strangerProject.id, "wl-worker-s");
  await admin.from("products").insert({ store_id: B, external_id: `gid://shopify/Product/${tag}`, title: "B's" });

  console.log("a ticket is minted for one store at a time");
  const { data: t1 } = await admin.rpc("abo_import_mint", { p_store: A });
  check("a connected store gets a ticket", typeof t1 === "string" && t1.length === 64);
  const { data: again } = await admin.rpc("abo_import_mint", { p_store: A });
  check("and a second cannot be minted while it lives", again === null);
  const { data: lease } = await admin.from("import_leases").select("ticket_hash").eq("store_id", A).single();
  check("the database keeps its hash, not the ticket", !!lease && !String(lease.ticket_hash).includes(t1));

  console.log("\nthe ticket reaches its own store's rows");
  const w = withTicket(t1);
  const { data: held } = await w.rpc("abo_import_store");
  check("it knows which store it is for", held?.[0]?.id === A && held?.[0]?.access_token === "fake-token-wl-worker-a");
  const { error: wroteA } = await w
    .from("products")
    .upsert(
      { store_id: A, external_id: `gid://shopify/Product/a-${tag}`, title: "A's" },
      { onConflict: "store_id,external_id" }
    );
  check("it can write that store's products", !wroteA);
  const { data: readA } = await w.from("products").select("id").eq("store_id", A);
  check("and read them back", (readA ?? []).length === 1);
  const { error: progressA } = await w
    .from("import_runs")
    .upsert({ store_id: A, resource: RESOURCES[0], status: "pending" }, { onConflict: "store_id,resource" });
  check("and record its progress", !progressA);

  console.log("\nand nothing else");
  const { data: readB } = await w.from("products").select("id").eq("store_id", B);
  check("not another store's rows", (readB ?? []).length === 0);
  const { error: wroteB } = await w.from("products").insert({ store_id: B, external_id: `x-${tag}`, title: "no" });
  check("nor write into another store", !!wroteB);
  const { error: progressB } = await w
    .from("import_runs")
    .insert({ store_id: B, resource: RESOURCES[0], status: "done" });
  check("nor another store's progress", !!progressB);
  for (const table of [
    "projects",
    "modules",
    "records",
    "account_settings",
    "store_actions",
    "shopify_data_requests",
  ]) {
    const { data } = await w.from(table).select("*").limit(5);
    check(`not ${table}`, (data ?? []).length === 0);
  }
  const { data: storeRows, error: storeErr } = await w.from("stores").select("id").eq("id", A);
  check("not even its own store's row", !!storeErr || (storeRows ?? []).length === 0);
  const renew = (client, store, token) =>
    client.rpc("abo_store_renewed", {
      p_store: store,
      p_access_token: token,
      p_refresh_token: null,
      p_token_expires_at: null,
      p_refresh_token_expires_at: null,
    });
  const { data: renewedB } = await renew(w, B, "stolen");
  check("it cannot replace another store's token", renewedB === false);
  const { data: stillB } = await admin.from("stores").select("access_token").eq("id", B).single();
  check("and that token is untouched", stillB?.access_token === "fake-token-wl-worker-b");
  const { data: renewedA } = await renew(w, A, "renewed-a");
  const { data: nowA } = await admin.from("stores").select("access_token").eq("id", A).single();
  check("but it can store its own store's renewed token", renewedA === true && nowA?.access_token === "renewed-a");

  console.log("\nno ticket, a guessed one, or a lapsed one gets nothing");
  const { data: noneHeld } = await nobody.rpc("abo_import_store");
  check("no ticket: no store", (noneHeld ?? []).length === 0);
  const { data: noneRead } = await nobody.from("products").select("id").in("store_id", [A, B]);
  check("no ticket: no rows", (noneRead ?? []).length === 0);
  const guess = withTicket(randomBytes(32).toString("hex"));
  const { data: guessHeld } = await guess.rpc("abo_import_store");
  check("a guessed ticket: no store", (guessHeld ?? []).length === 0);
  const { error: guessWrote } = await guess
    .from("products")
    .insert({ store_id: A, external_id: `g-${tag}`, title: "no" });
  check("a guessed ticket: no writes", !!guessWrote);
  await admin
    .from("import_leases")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("store_id", A);
  const { data: lapsedHeld } = await w.rpc("abo_import_store");
  check("a lapsed ticket: no store", (lapsedHeld ?? []).length === 0);
  const { error: lapsedWrote } = await w.from("products").insert({ store_id: A, external_id: `l-${tag}`, title: "no" });
  check("a lapsed ticket: no writes", !!lapsedWrote);
  const { data: lapsedRenew } = await w.rpc("abo_import_renew", { p_seconds: 360 });
  check("and it cannot bring itself back", lapsedRenew === false);

  console.log("\na ticket's life is bounded");
  const { data: t2 } = await admin.rpc("abo_import_mint", { p_store: A });
  check("once lapsed, the store can be minted for again", typeof t2 === "string" && t2 !== t1);
  const w2 = withTicket(t2);
  const { data: stretched } = await w2.rpc("abo_import_renew", { p_seconds: 999999 });
  const { data: leased } = await admin.from("import_leases").select("expires_at").eq("store_id", A).single();
  check(
    "a renewal is capped at ten minutes",
    stretched === true && Date.parse(leased.expires_at) <= Date.now() + 601_000
  );
  await admin
    .from("import_leases")
    .update({ taken_at: new Date(Date.now() - 31 * 60_000).toISOString() })
    .eq("store_id", A);
  const { data: tooOld } = await w2.rpc("abo_import_renew", { p_seconds: 360 });
  check("and not at all half an hour after it was minted", tooOld === false);
  await w2.rpc("abo_import_release");
  const { data: gone } = await admin.from("import_leases").select("store_id").eq("store_id", A);
  check("giving it back frees the store", (gone ?? []).length === 0);
  const { data: t3 } = await admin.rpc("abo_import_mint", { p_store: A });
  const { data: handed } = await withTicket(t3).rpc("abo_import_continue");
  check("handing over with no worker address says so", handed === "not_configured");
  const { data: goneAgain } = await admin.from("import_leases").select("store_id").eq("store_id", A);
  check("and leaves the store free", (goneAgain ?? []).length === 0);

  console.log("\nwho may start one");
  const asOwner = (p) =>
    fetch(`${APP}/api/shopify/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${me.session.access_token}` },
      body: JSON.stringify(p),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const kicked = await asOwner({ projectId: mine.id, kick: true });
  check(
    "the owner may, and hears there is no worker here",
    kicked.status === 200 && kicked.body.kicked === "not_configured"
  );
  const { error: notYours } = await owner.rpc("abo_import_kick", { p_store: S });
  check("nobody may for a store that is not theirs", !!notYours);
  const { error: anonKick } = await nobody.rpc("abo_import_kick", { p_store: A });
  check("and nobody signed out may at all", !!anonKick);
  for (const [fn, args] of [
    ["abo_import_mint", { p_store: A }],
    ["abo_import_dispatch", { p_store: A }],
    ["abo_import_tick", {}],
    ["abo_import_sweep", {}],
  ]) {
    const { error: asNobody } = await nobody.rpc(fn, args);
    const { error: asMerchant } = await owner.rpc(fn, args);
    check(`${fn} is the database's own`, !!asNobody && !!asMerchant);
  }
  // Connecting sends a dispatch; without an address it must not break the connect.
  await admin.from("stores").update({ status: "pending" }).eq("id", A);
  const { error: reconnect } = await admin.from("stores").update({ status: "connected" }).eq("id", A);
  const { data: noLease } = await admin.from("import_leases").select("store_id").eq("store_id", A);
  check("a connect with no worker address still connects", !reconnect && (noLease ?? []).length === 0);

  console.log("\nthe worker route");
  const post = (b) =>
    fetch(`${APP}/api/shopify/import/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    }).then((r) => r.status);
  check("nothing sent: refused", (await post({})) === 400);
  check("a guessed ticket: refused", (await post({ store: A, ticket: randomBytes(32).toString("hex") })) === 401);
  const { data: t4 } = await admin.rpc("abo_import_mint", { p_store: A });
  check("a real ticket for another store: refused", (await post({ store: B, ticket: t4 })) === 401);
  check("a real ticket for its store: accepted", (await post({ store: A, ticket: t4 })) === 202);

  // The store is made up, so Shopify refuses it; what matters is that
  // the worker noticed, wrote it down, and let go.
  let runs = [];
  let released = false;
  for (let i = 0; i < 40 && !released; i++) {
    await sleep(1000);
    ({ data: runs } = await admin
      .from("import_runs")
      .select("resource, status, attempts, retry_at, error")
      .eq("store_id", A));
    const { data: l } = await admin.from("import_leases").select("store_id").eq("store_id", A);
    released = (l ?? []).length === 0 && (runs ?? []).some((r) => r.status === "failed");
  }
  check("it gives the ticket back when it stops", released);
  check("every resource in the registry has its progress row", (runs ?? []).length === RESOURCES.length);
  const failed = (runs ?? []).find((r) => r.status === "failed");
  check("the failure is recorded, with why", !!failed?.error && failed?.attempts === 1);
  check("and it is the first resource, so nothing after it ran", failed?.resource === RESOURCES[0]);

  // A merchant asking where it stands sees when it tries again, or that it stopped.
  const status = await asOwner({ projectId: mine.id, status: true });
  const first = status.body.progress?.[RESOURCES[0]];
  check("the owner sees it failed", first?.status === "failed");
  check(
    "and either when it tries again, or that it has stopped",
    failed?.retry_at ? first?.retry_at === failed.retry_at : status.body.stopped?.resource === RESOURCES[0]
  );
} finally {
  await mine.remove();
  await theirs.remove();
  if (strangerProject?.id) await admin.from("projects").delete().eq("id", strangerProject.id);
  if (stranger) await admin.auth.admin.deleteUser(stranger);
}

console.log(
  fails.length === 0 ? "\na ticket opens one store's rows, and only while it lives" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
