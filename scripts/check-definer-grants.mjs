// No security definer function is a door the public key can walk through.
//
// Supabase lets anon and authenticated execute every new function in
// public. A security definer function runs as its owner, past row-level
// security, so one the public key can call must check its caller itself.
// Helpers written for triggers and cron jobs did not, and six stood open
// until 0117: one of them could rewrite any project's records.
//
// So every such function the public key can execute must either check
// its caller in its body, or be one of the few doors guarded another way,
// listed below with what guards them. A new helper that forgets to close
// itself fails here, before it is pushed.
//
//   node scripts/check-definer-grants.mjs   (needs SUPABASE_ACCESS_TOKEN)

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.check.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** Doors the public key may use, each guarded by something other than who is asking. */
const GUARDED = {
  abo_shopify_webhook: "Shopify's signature over the body, checked against the app secret",
  abo_shopify_uninstalled: "Shopify's signature",
  abo_shopify_compliance: "Shopify's signature",
  abo_shopify_connect: "a one-time OAuth state minted for the signed-in owner",
  abo_import_store: "the import worker's ticket",
  abo_import_continue: "the import worker's ticket",
  abo_import_holds: "the import worker's ticket",
  abo_import_release: "the import worker's ticket",
  abo_import_renew: "the import worker's ticket",
  abo_invite_peek: "the invite link's own token, 192 random bits, and it tells only about that link",
};

/** What a body that checks its caller says. */
const CHECKS_CALLER = String.raw`auth\.uid\(\)|abo_is_superadmin|abo_admin_may_manage|abo_is_member|abo_is_owner|abo_can_|auth\.jwt|abo_member|abo_owns|current_setting\('request`;

const OPEN_DOORS = `
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authed
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   -- An extension's own functions are the extension's business.
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
   and p.prosrc !~ '${CHECKS_CALLER.replace(/'/g, "''")}'
 order by 1`;

console.log("security definer functions the public key can run");
const open = await sql(OPEN_DOORS);
const unguarded = open.filter((f) => !GUARDED[f.proname]);
check(`each checks its caller or is a guarded door (${open.length - unguarded.length} guarded doors)`, unguarded.length === 0);
for (const f of unguarded) console.log(`     → ${f.proname} (anon ${f.anon}, signed in ${f.authed})`);
const stale = Object.keys(GUARDED).filter((n) => !open.some((f) => f.proname === n));
check("and the list of guarded doors names only doors that exist", stale.length === 0);
if (stale.length) console.log("     →", stale.join(", "));

console.log(fails.length === 0 ? "\nno door the public key was not meant to have" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
