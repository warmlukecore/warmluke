// Browsing the landing never uses up a booking's room (0116), and a
// booking comes only through the form (0160).
//
// Every click in the landing's glimpse of the app is an event, and a
// session may write sixty an hour. A booking counted against the same
// sixty was refused after enough curiosity: the lead lost to the
// clicks. Bookings are counted on their own, with their own cap.
//
// And a booking is written only with the server's key: the public key
// alone, the way a script skipping the form and its CAPTCHA would try,
// is refused. As a visitor writes them, in one transaction that is
// rolled back, with a key of its own for the length of it.
//
//   ENV_FILE=.env.check.local node scripts/check-landing-cap.mjs

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
);
if (env.CHECK_PROJECT !== "1") throw new Error(`${envFile} is not the check project's; this writes`);
if (!env.DATABASE_URL) throw new Error(`${envFile} has no DATABASE_URL`);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const psql = (sql) => {
  const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
  if (r.status !== 0) throw new Error(r.stderr.slice(0, 600));
  return Object.fromEntries(
    r.stdout
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)])
  );
};

const KEY = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");
const S = `'chk_cap_${tag}'`;
const T = `'chk_cap2_${tag}'`;
// A booking as the server sends it; each argument is SQL, so a series can name the idem.
const book = (key, session, idem) =>
  `pg_temp.try(format($q$select public.abo_book_demo(%L, jsonb_build_object('session_id', %L, 'idem', %L,
     'payload', jsonb_build_object('name', 'Cap check')))$q$, ${key}, ${session}, ${idem}))`;
const mine = `'${KEY}'`;

const r = psql(`
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
begin execute t; return 'ok'; exception when others then return 'ERR ' || sqlstate; end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;
insert into public.app_secrets (name, value) values ('booking_key_sha256', encode(extensions.digest(${mine}, 'sha256'), 'hex'))
  on conflict (name) do update set value = excluded.value;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select pg_temp.say('clicks', pg_temp.try(format($q$insert into public.landing_events (session_id, event, payload)
  select %L, 'cta_click', jsonb_build_object('cta', 'preview_' || i) from generate_series(1, 60) i$q$, ${S})));
select pg_temp.say('click61', pg_temp.try(format($q$insert into public.landing_events (session_id, event)
  values (%L, 'cta_click')$q$, ${S})));
select pg_temp.say('direct', pg_temp.try(format($q$insert into public.landing_events (session_id, event, idem, payload)
  values (%L, 'demo_booked', 'direct', '{"name": "Skipped the form"}')$q$, ${T})));
select pg_temp.say('no_key', ${book("null::text", T, "'nokey'")});
select pg_temp.say('wrong_key', ${book(`'${"0".repeat(64)}'`, T, "'wrong'")});
select pg_temp.say('first', ${book(mine, S, "'cap1'")});
select pg_temp.say('next', (select string_agg(${book(mine, S, "'cap' || i")}, ',' order by i) from generate_series(2, 5) i));
select pg_temp.say('sixth', ${book(mine, S, "'cap6'")});
select pg_temp.say('again', ${book(mine, T, "'same'")} || ',' || ${book(mine, T, "'same'")});
reset role;
select pg_temp.say('kept', (select string_agg(event || ':' || (payload ->> 'name'), ',')
                              from public.landing_events where session_id = ${T}));

select k, v from out;
rollback;
`);

console.log("a visitor who clicks around, then books");
check("sixty clicks in an hour are taken", r.clicks === "ok");
check("the sixty-first is refused", r.click61 === "ERR 53400");
check("and a booking still goes through", r.first === "ok");

console.log("\nand a script that books over and over");
check("five bookings in an hour are taken", r.next === "ok,ok,ok,ok");
check("the sixth is refused", r.sixth === "ERR 53400");

console.log("\na booking comes only through the form");
check("the public key alone cannot write one", r.direct === "ERR 42501");
check("nor the function without the server's key", r.no_key === "ERR 42501");
check("nor with a key that is not it", r.wrong_key === "ERR 42501");
check("the same booking sent twice lands once", r.again === "ok,ERR 23505");
check("and nothing but the form's booking is written", r.kept === "demo_booked:Cap check");

console.log(
  fails.length === 0 ? "\nbrowsing never costs a booking, and only the form books" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
