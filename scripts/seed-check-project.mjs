// What the check project needs to have before the checks can run.
//
// A blank database has no administrator, and check-admin needs one to
// sign in as. The check user is it, here. And it has no store, so the
// checks that read one said "nothing to check" and passed: the seeded
// shop (scripts/fixtures/seed-shop.ts) is made again, from nothing, on
// every run, under an account of its own. Meant for the check project
// only: run it against production and you would make the check account
// an administrator of the real one, so it refuses unless the file
// declares CHECK_PROJECT=1.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/seed-check-project.mjs --env .env.check.local

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SEED_EMAIL, SEED_SHOP, signInAsCheckUser, signInAsOwner } from "./owner-session.mjs";
import { SEED_CURRENCY, SEED_TIMEZONE, seedNodes, seedShop } from "./fixtures/seed-shop.ts";
import { RESOURCES } from "../src/lib/shopify-resources.ts";

const args = process.argv.slice(2);
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : ".env.local";
process.env.ENV_FILE = envFile;
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
// The file has to say so. A name was the first guard, and CI writes
// the check project's values to a file called .env.local — so the
// guard is what the file declares, which any env file can, and
// production's never will.
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1 — this makes the check user an administrator of whatever project that file points at, so it refuses`);
  process.exit(2);
}
const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const me = await signInAsCheckUser(anon, env);
if (!me.session) { console.log("no check user:", me.why); process.exit(1); }
const { error } = await admin
  .from("account_settings")
  .update({ is_superadmin: true })
  .eq("user_id", me.user.id);
if (error) { console.log("could not promote:", error.message); process.exit(1); }
const ref = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];
console.log(`${ref}: ${me.user.email} is an administrator`);

// ── The seeded shop ─────────────────────────────────────────────
// Made again from nothing each run, so it is exactly the fixture: a
// check that wrote into it and crashed, or a row the fixture no longer
// has, does not outlive the next seed.
const made = await admin.auth.admin.createUser({ email: SEED_EMAIL, password: `${crypto.randomUUID()}Aa1!`, email_confirm: true });
if (made.error && !/already|exists|registered/i.test(made.error.message)) {
  console.log("could not make the seed account:", made.error.message);
  process.exit(1);
}
const seed = await signInAsOwner(
  createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY),
  env,
  SEED_EMAIL
);
if (!seed.session) { console.log("no seed account:", seed.why); process.exit(1); }
await admin.from("account_settings").upsert({ user_id: seed.user.id }, { onConflict: "user_id", ignoreDuplicates: true });
const gone = await admin.from("projects").delete().eq("owner_id", seed.user.id);
if (gone.error) { console.log("could not clear the old seed:", gone.error.message); process.exit(1); }
const { data: project, error: pe } = await admin
  .from("projects")
  .insert({ owner_id: seed.user.id, name: "Seed shop" })
  .select("id")
  .single();
if (pe) { console.log("could not make the seed project:", pe.message); process.exit(1); }
const now = new Date().toISOString();
const { data: store, error: se } = await admin
  .from("stores")
  .insert({
    project_id: project.id, provider: "shopify", shop_domain: SEED_SHOP, status: "connected",
    // Not a token: no Shopify answers for this shop, and nothing calls one for it (shopifyStores).
    access_token: "seed-token-opens-nothing",
    currency: SEED_CURRENCY, timezone: SEED_TIMEZONE, country: "IN", connected_at: now, last_synced_at: now,
  })
  .select("id")
  .single();
if (se) { console.log("could not make the seed store:", se.message); process.exit(1); }
await seedShop(admin, store.id);
// An import that finished, per resource, so nothing reads the shop as still arriving.
const nodes = seedNodes();
const runs = await admin.from("import_runs").insert(
  RESOURCES.map((resource) => ({ store_id: store.id, resource, status: "done", imported: nodes[resource].length, finished_at: now }))
);
if (runs.error) { console.log("could not record the seed import:", runs.error.message); process.exit(1); }
const { count } = await admin.from("orders").select("id", { count: "exact", head: true }).eq("store_id", store.id);
console.log(`${ref}: ${SEED_SHOP} seeded for ${SEED_EMAIL}, ${count} orders`);
