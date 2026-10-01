// The app server's key for reading Shopify apps of a store's own (0150).
//
// Makes a random key, keeps only its sha256 in the database
// (app_secrets.shopify_apps_key_sha256), and writes the key itself as
// SHOPIFY_APPS_KEY into the env file given, and, with --vercel, into the
// Vercel project's production settings through the CLI. The key is
// never printed. Running it again makes a new key and retires the old.
//
//   node scripts/set-shopify-apps-key.mjs --env .env.check.local
//   node scripts/set-shopify-apps-key.mjs --env .env.local --vercel

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;
if (!envFile) {
  console.error("Say which env file: --env .env.check.local or --env .env.local");
  process.exit(1);
}
const text = readFileSync(envFile, "utf8");
const env = Object.fromEntries(
  text
    .split("\n")
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
);
const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const service = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
if (!url || !service) {
  console.error(`${envFile} needs NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL and ADAPTIVE_OS_SERVICE_ROLE_KEY.`);
  process.exit(1);
}

const key = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(key).digest("hex");

const r = await fetch(`${url}/rest/v1/app_secrets?on_conflict=name`, {
  method: "POST",
  headers: {
    apikey: service,
    Authorization: `Bearer ${service}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify({ name: "shopify_apps_key_sha256", value: hash, updated_at: new Date().toISOString() }),
});
if (!r.ok) {
  console.error(`The database refused it (${r.status}): ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}

const line = `SHOPIFY_APPS_KEY=${key}`;
const kept = /^SHOPIFY_APPS_KEY=.*$/m.test(text)
  ? text.replace(/^SHOPIFY_APPS_KEY=.*$/m, line)
  : `${text.replace(/\n?$/, "\n")}${line}\n`;
writeFileSync(envFile, kept);
console.log(`ok    the database keeps its fingerprint; ${envFile} has the key`);

if (args.includes("--vercel")) {
  // Replaced, not added beside: the CLI refuses a second value for the same name.
  spawnSync("vercel", ["env", "rm", "SHOPIFY_APPS_KEY", "production", "--yes"], { stdio: "ignore" });
  const add = spawnSync("vercel", ["env", "add", "SHOPIFY_APPS_KEY", "production"], {
    input: key,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (add.status !== 0) {
    console.error(`Vercel did not take it: ${String(add.stderr).slice(0, 300)}`);
    console.error("Add SHOPIFY_APPS_KEY to the project's production settings by hand, from the env file.");
    process.exit(1);
  }
  console.log("ok    Vercel's production settings have it; it takes effect on the next deploy");
}
