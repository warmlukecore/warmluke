// Moves one project's data into another built from the same migrations:
// the region move (Sydney to Mumbai, 2026-09-30), and any move after it,
// a US copy included. Through the management API, so both projects are
// reached with the account's token and neither needs its password here.
//
// The target is built first (scripts/apply-migrations.mjs --env <to>): its
// tables come from the repo, not from the source. Then this copies every
// row of public, the users and their sign-in identities from auth, the
// vault's secrets, and, asked to, the sign-in settings. Rows go in with
// triggers off (session_replication_role = replica), so a copied order is
// not a new order to the target's rules and a row's owner need not land
// before it. Sessions, OAuth grants and one-time tokens are not copied:
// everyone signs in again once, and a connected AI connects again.
//
// Nothing secret is printed: not a key, a password hash or a vault value.
//
//   node scripts/move-project.mjs --from .env.local --to .env.mumbai.local                    counts only
//   node scripts/move-project.mjs --from .env.local --to .env.mumbai.local --copy             into an empty target
//   node scripts/move-project.mjs --from .env.local --to .env.mumbai.local --copy --replace --vault   the final copy
//   node scripts/move-project.mjs --from .env.local --to .env.mumbai.local --auth-config      sign-in settings
//
// The target needs pg_cron switched on before it is built (the migrations
// schedule its jobs only where it is): create extension pg_cron.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const readEnv = (file) => {
  const env = Object.fromEntries(
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
  );
  const ref = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error(`${file} has no SUPABASE_ACCESS_TOKEN`);
  return { ref, token: env.SUPABASE_ACCESS_TOKEN, checkProject: env.CHECK_PROJECT === "1" };
};
const fromFile = value("--from");
const toFile = value("--to");
if (!fromFile || !toFile) {
  console.log("usage: --from <env file> --to <env file> [--copy [--replace]] [--auth-config]");
  process.exit(2);
}
const from = readEnv(fromFile);
const to = readEnv(toFile);
if (from.ref === to.ref) {
  console.log("the source and the target are the same project");
  process.exit(2);
}

const api = async (p, path, init = {}) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${p.ref}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(`${p.ref} ${path}: ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    e.said = JSON.stringify(body ?? "");
    throw e;
  }
  return body;
};
const sql = (p, query) => api(p, "/database/query", { method: "POST", body: JSON.stringify({ query }) });

/** What is copied: every table of public, and of auth only who the users are. */
const SKIP_PUBLIC = new Set(["abo_migrations", "code_leases", "import_leases"]);
const AUTH_TABLES = ["users", "identities", "mfa_factors"];

async function tablesOf(p) {
  const rows = await sql(
    p,
    `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = any(array[${AUTH_TABLES.map((t) => `'${t}'`).join(",")}])))
      order by 1, 2`
  );
  return rows.filter((r) => !(r.s === "public" && SKIP_PUBLIC.has(r.t))).map((r) => `${r.s}.${r.t}`);
}

/** A table's columns that can be written, its key to page by, and whether it numbers its own rows. */
async function shapeOf(p, table) {
  const [s, t] = table.split(".");
  const cols = await sql(
    p,
    `select a.attname as name, a.attidentity as identity from pg_attribute a
      where a.attrelid = '${s}.${t}'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      order by a.attnum`
  );
  const key = await sql(
    p,
    `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = '${s}.${t}'::regclass and i.indisprimary`
  );
  const q = (c) => `"${c.replace(/"/g, '""')}"`;
  return {
    cols: cols.map((c) => q(c.name)).join(", "),
    order: (key.length ? key.map((k) => q(k.name)) : cols.slice(0, 1).map((c) => q(c.name))).join(", "),
    always: cols.some((c) => c.identity === "a"),
  };
}

const countOf = async (p, table) => Number((await sql(p, `select count(*)::bigint as n from ${table}`))[0].n);

const PAGE = 200;

async function copyTable(table) {
  const shape = await shapeOf(to, table);
  const total = await countOf(from, table);
  for (let at = 0; at < total; at += PAGE) {
    const [{ rows }] = await sql(
      from,
      `select coalesce(json_agg(t), '[]'::json) as rows from (select ${shape.cols} from ${table} order by ${shape.order} offset ${at} limit ${PAGE}) t`
    );
    const json = JSON.stringify(rows);
    const tag = `$wl${randomBytes(6).toString("hex")}$`;
    await sql(
      to,
      `set session_replication_role = replica;
       insert into ${table} (${shape.cols}) ${shape.always ? "overriding system value" : ""}
       select ${shape.cols} from json_populate_recordset(null::${table}, ${tag}${json}${tag}::json);
       set session_replication_role = origin;`
    );
  }
  return total;
}

/** Sequences behind numbered columns, past the rows that came in. */
async function resetSequences(tables) {
  for (const table of tables) {
    const seqs = await sql(
      to,
      `select a.attname as col, pg_get_serial_sequence('${table}', a.attname) as seq from pg_attribute a
        where a.attrelid = '${table}'::regclass and a.attnum > 0 and not a.attisdropped
          and pg_get_serial_sequence('${table}', a.attname) is not null`
    );
    for (const s of seqs) {
      await sql(to, `select setval('${s.seq}', greatest(coalesce((select max("${s.col}") from ${table}), 0), 1))`);
    }
  }
}

async function copyVault() {
  const secrets = await sql(
    from,
    `select name, decrypted_secret as v from vault.decrypted_secrets where name is not null`
  );
  for (const s of secrets) {
    const tag = `$wl${randomBytes(6).toString("hex")}$`;
    await sql(
      to,
      `delete from vault.secrets where name = ${tag}${s.name}${tag};
       select vault.create_secret(${tag}${s.v}${tag}, ${tag}${s.name}${tag});`
    );
  }
  return secrets.map((s) => s.name);
}

async function copyAuthConfig() {
  const config = await api(from, "/config/auth");
  // Limits the new project keeps as its own.
  for (const k of Object.keys(config))
    if (/^(jwt_secret|db_max_pool_size|api_max_request_duration)/.test(k)) delete config[k];
  // Without a mail server of their own, the sender's name and the mail rate
  // belong to Supabase's, and a new project refuses them (2026-09-30).
  // The mails' own wording too: a free project on Supabase's sender keeps
  // Supabase's templates, and says so when sent others (2026-09-30).
  if (!config.smtp_host)
    for (const k of Object.keys(config))
      if (/^smtp_|^rate_limit_email_sent$|^mailer_(templates|subjects)_/.test(k)) delete config[k];
  // Hooks are a paid plan's, and a free one refuses them even switched off.
  // None switched on, none sent.
  if (!Object.entries(config).some(([k, v]) => /^hook_.*_enabled$/.test(k) && v === true))
    for (const k of Object.keys(config)) if (k.startsWith("hook_")) delete config[k];
  const set = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null));
  const left = [];
  // A field this project will not take is named and left out, never guessed at.
  for (let tries = 0; tries < 8; tries++) {
    try {
      await api(to, "/config/auth", { method: "PATCH", body: JSON.stringify(set) });
      if (left.length) console.log(`sign-in settings left out: ${left.join(", ")}`);
      return Object.keys(set).length;
    } catch (e) {
      const names = [...String(e.said ?? e.message).matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) =>
        m[1].toLowerCase()
      );
      const named = Object.keys(set).filter((k) => names.some((n) => k === n || k.startsWith(`${n}_`)));
      if (!named.length) throw e;
      for (const k of named) {
        delete set[k];
        left.push(k);
      }
    }
  }
  throw new Error(`sign-in settings were refused; left out so far: ${left.join(", ")}`);
}

if (flag("--auth-config")) console.log(`sign-in settings: ${await copyAuthConfig()} copied`);
// Settings alone read no table, so the source can be a paused project: the
// Mumbai check project took the paused Sydney one's this way (2026-09-30).
if (flag("--auth-config") && !flag("--copy") && !flag("--vault")) process.exit(0);

const tables = await tablesOf(from);
const theirs = new Set(await tablesOf(to));
const missing = tables.filter((t) => !theirs.has(t));
if (missing.length) {
  console.log(
    `the target lacks ${missing.length} table(s) the source has: ${missing.join(", ")}. Build it first: scripts/apply-migrations.mjs --env ${toFile}`
  );
  process.exit(1);
}

if (flag("--copy")) {
  if (to.checkProject) {
    console.log(`${toFile} is a check project; production's rows do not go there`);
    process.exit(2);
  }
  const already = (await countOf(to, "public.projects")) + (await countOf(to, "auth.users"));
  if (already > 0 && !flag("--replace")) {
    console.log(`the target already has ${already} project(s) and user(s); pass --replace to empty it and copy again`);
    process.exit(1);
  }
  if (already > 0) {
    await sql(
      to,
      `set session_replication_role = replica; truncate ${tables.join(", ")} cascade; set session_replication_role = origin;`
    );
    console.log("the target emptied");
  }
  for (const t of tables) {
    const n = await copyTable(t);
    if (n) console.log(`  ${t}: ${n}`);
  }
  await resetSequences(tables);
}
// Only at the switch: the vault holds where the scheduled jobs send their work
// (the app's own address), and a copy that had them would send production work
// from a database production does not read, every minute.
if (flag("--vault")) console.log(`vault: ${(await copyVault()).join(", ") || "nothing"}`);

console.log(`\n${from.ref} → ${to.ref}, row by row`);
let unequal = 0;
for (const t of tables) {
  const a = await countOf(from, t);
  const b = await countOf(to, t);
  if (a === 0 && b === 0) continue;
  if (a !== b) unequal++;
  console.log(`  ${a === b ? "ok  " : "DIFF"}  ${t.padEnd(34)} ${String(a).padStart(6)} ${String(b).padStart(6)}`);
}
console.log(unequal ? `\n${unequal} table(s) differ` : "\nevery table has the same rows");
process.exit(unequal ? 1 : 0);
