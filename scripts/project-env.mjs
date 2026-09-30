// Writes a local env file for a project in this account: its address and
// keys, read from the management API with the account's token, and the
// token itself so scripts can reach it. Nothing is printed but the names.
//
// For a project the scripts have not met yet: the region move's Mumbai
// project (2026-09-30), a check project rebuilt, a US copy later.
//
//   node scripts/project-env.mjs --ref <project ref> --out .env.mumbai.local [--check]
//
// --check marks the file as a check project's (CHECK_PROJECT=1), which the
// seed and the checks require before they touch it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const ref = value("--ref");
const out = value("--out");
if (!ref || !/^[a-z0-9]{20}$/.test(ref) || !out || !/^\.env\.[a-z-]+\.local$/.test(out)) {
  console.log("usage: --ref <20-letter project ref> --out .env.<name>.local [--check]");
  process.exit(2);
}
if (existsSync(new URL(`../${out}`, import.meta.url))) {
  console.log(`${out} is there already; it is not overwritten`);
  process.exit(2);
}
const local = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const token = local.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.log(".env.local has no SUPABASE_ACCESS_TOKEN");
  process.exit(2);
}
const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!r.ok) {
  console.log(`the keys could not be read: ${r.status}`);
  process.exit(1);
}
const keys = await r.json();
// The legacy pair when the project has it, else the newer publishable and secret keys.
const pick = (...names) => keys.find((k) => names.includes(k.name) || names.includes(k.type))?.api_key;
const anon = pick("anon", "publishable");
const service = pick("service_role", "secret");
if (!anon || !service) {
  console.log(`the project did not hand over both keys (it named: ${keys.map((k) => k.name).join(", ")})`);
  process.exit(1);
}
const lines = [
  `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL=https://${ref}.supabase.co`,
  `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY=${anon}`,
  `ADAPTIVE_OS_SERVICE_ROLE_KEY=${service}`,
  `SUPABASE_ACCESS_TOKEN=${token}`,
  ...(args.includes("--check") ? ["CHECK_PROJECT=1"] : []),
];
writeFileSync(new URL(`../${out}`, import.meta.url), `${lines.join("\n")}\n`, { mode: 0o600 });
console.log(`${out} written for ${ref}: ${lines.map((l) => l.slice(0, l.indexOf("="))).join(", ")}`);
