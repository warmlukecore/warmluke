// Invite only (0141), asked of the database.
//
// The pages say "invite only", but supabase-js can make an account with
// the public key from anywhere, so the rule that matters is the one on
// the insert of a project. This turns the switch on, tries each kind of
// account, and turns it off again: on a check project it is always off,
// whatever a run that crashed halfway may have left behind.
//
//   ENV_FILE=.env.check.local node scripts/check-invite-only.mjs
//
// Turns a switch the whole project shares: never while another run is
// using the check project.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this turns a switch every account shares, so it runs only there");
  process.exit(0);
}
const BASE = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;

const rest =
  (jwt) =>
  async (path, init = {}) => {
    const r = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...init.headers,
      },
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, json: body ? JSON.parse(body) : null };
  };
const svc = rest(SVC);
const pub = rest(ANON);

async function signup(email) {
  const r = await fetch(`${BASE}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test-passw0rd!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`signup failed: ${JSON.stringify(j).slice(0, 200)}`);
  return { jwt: j.access_token, id: j.user.id, email };
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const startsApp = async (who) =>
  (
    await rest(who.jwt)("projects?select=id", {
      method: "POST",
      body: JSON.stringify({ owner_id: who.id, name: "Mine" }),
    })
  ).ok;

const stamp = Date.now();
const [before] = (await svc("signup_gate?select=invite_only,invite_only_since")).json ?? [];
if (!before) {
  console.log("no signup_gate on this database: apply migration 0141");
  process.exit(1);
}
const users = [];
try {
  // Made while the door is open: one who never used it, one who did.
  const early = await signup(`gate-early-${stamp}@warmluke.test`);
  const owner = await signup(`gate-owner-${stamp}@warmluke.test`);
  users.push(early, owner);
  check("with the door open, anyone starts an app", await startsApp(owner));

  // On the database's clock, not this machine's: just after those two were made.
  const made = await Promise.all(
    [early, owner].map((u) =>
      fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
        .then((r) => r.json())
        .then((j) => Date.parse(j.created_at))
    )
  );
  await svc("signup_gate?id=eq.true", {
    method: "PATCH",
    body: JSON.stringify({ invite_only: true, invite_only_since: new Date(Math.max(...made) + 1).toISOString() }),
  });
  console.log("\ninvite only");
  check("anyone can read that it is", (await pub("signup_gate?select=invite_only")).json?.[0]?.invite_only === true);
  check(
    "and nobody can change it with the public key",
    (await pub("signup_gate?id=eq.true", { method: "PATCH", body: JSON.stringify({ invite_only: false }) })).json
      ?.length !== 1
  );

  const stranger = await signup(`gate-stranger-${stamp}@warmluke.test`);
  users.push(stranger);
  check("a stranger can still make an account", !!stranger.jwt);
  check("but not start an app", !(await startsApp(stranger)));
  check(
    "nor turn the switch off themselves",
    !(
      await rest(stranger.jwt)("rpc/abo_admin_set_invite_only", {
        method: "POST",
        body: JSON.stringify({ p_on: false }),
      })
    ).ok
  );

  // An invite made for them, the way the admin screen makes one.
  const invited = await signup(`gate-invited-${stamp}@warmluke.test`);
  users.push(invited);
  const [invite] = (
    await svc("account_invites", {
      method: "POST",
      body: JSON.stringify({ email: invited.email, created_by: owner.id }),
    })
  ).json;
  const claimed = await rest(invited.jwt)("rpc/abo_invite_claim", {
    method: "POST",
    body: JSON.stringify({ p_token: invite.token }),
  });
  check("the invited one takes their invite", claimed.ok);
  check("and starts an app", await startsApp(invited));

  check("an account from before it went on still starts one", await startsApp(early));
  check("and an owner keeps building", await startsApp(owner));

  // Added to someone's team, with no invite of their own.
  const packer = await signup(`gate-packer-${stamp}@warmluke.test`);
  users.push(packer);
  const [proj] = (await rest(owner.jwt)("projects?select=id&limit=1&order=created_at")).json;
  const [seat] = (
    await rest(owner.jwt)("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })
  ).json;
  const joined = await rest(packer.jwt)("rpc/abo_join", {
    method: "POST",
    body: JSON.stringify({ p_token: seat.token }),
  });
  check("someone added to a team still joins it", joined.json === proj.id);
  check("and opens the app", (await rest(packer.jwt)(`projects?id=eq.${proj.id}&select=id`)).json?.length === 1);
  check("but starting their own takes an invite", !(await startsApp(packer)));
} finally {
  await svc("signup_gate?id=eq.true", {
    method: "PATCH",
    body: JSON.stringify({ invite_only: false, invite_only_since: null }),
  });
  for (const u of users) {
    await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
  }
  console.log(
    `\nthe switch is off again${before.invite_only ? " (it was left on before this run)" : ""}; test users removed`
  );
}

console.log(fails.length === 0 ? "\nonly an invite starts an app" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
