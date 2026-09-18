// What the check project needs to have before the checks can run.
//
// A blank database has no administrator, and check-admin needs one to
// sign in as. The check user is it, here. Idempotent, and meant for
// the check project only — run it against production and you would
// make the check account an administrator of the real one, so it
// refuses unless the file it is given is not .env.local.
//
//   node scripts/seed-check-project.mjs --env .env.check.local

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser } from "./owner-session.mjs";

const args = process.argv.slice(2);
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;
if (!envFile || envFile === ".env.local") {
  console.log("say which project with --env, and not .env.local — this makes the check user an administrator there");
  process.exit(2);
}
process.env.ENV_FILE = envFile;
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
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
