// Who did it, and what it was before (0144), asked of the database.
//
// A row's "who" is the login that saved it, never what anybody sends:
// a team member who claims the owner added their row is still the one who
// added it. Every add, change and removal is kept with its before and
// after, read by whoever may see the section and written by nobody but
// the table itself.
//
//   ENV_FILE=.env.check.local node scripts/check-row-history.mjs

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this makes accounts and rows of its own, so it runs only there");
  process.exit(0);
}
const BASE = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;

const rest =
  (jwt) =>
  async (path, init = {}) => {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...init.headers,
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, json: body ? JSON.parse(body) : null };
  };

async function signup(email) {
  const j = await fetch(`${BASE}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test-passw0rd!" }),
  }).then((x) => x.json());
  if (!j.access_token) throw new Error(`signup failed: ${JSON.stringify(j).slice(0, 200)}`);
  return { jwt: j.access_token, id: j.user.id, email };
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const stamp = Date.now();
const owner = await signup(`hist-owner-${stamp}@warmluke.test`);
const staff = await signup(`hist-staff-${stamp}@warmluke.test`);
const outsider = await signup(`hist-out-${stamp}@warmluke.test`);
const O = rest(owner.jwt);
const S = rest(staff.jwt);
const X = rest(outsider.jwt);

try {
  const [proj] = (
    await O("projects", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: "History" }) })
  ).json;
  const [mod] = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `packing_${stamp}`,
        nav_label: "Packing",
        route: `/packing_${stamp}`,
        shared_with_team: true,
      }),
    })
  ).json;
  const [seat] = (await O("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).json;
  await fetch(`${BASE}/rest/v1/rpc/abo_join`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: seat.token }),
  });
  await fetch(`${BASE}/rest/v1/rpc/abo_member_about`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: proj.id, p_name: "Meera", p_role: "warehouse" }),
  });

  console.log("who, on the row, from the session");
  const [row] = (
    await S("records", {
      method: "POST",
      // Claiming the owner added it: the database has the last word.
      body: JSON.stringify({
        project_id: proj.id,
        module_id: mod.id,
        data: { order: "#1001", packed: false },
        created_by: owner.id,
        updated_by: owner.id,
      }),
    })
  ).json;
  check("the one who added it is the login that saved it", row?.created_by === staff.id);
  check("not the one they claimed", row?.updated_by === staff.id);
  const [changed] = (
    await O(`records?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { order: "#1001", packed: true }, created_by: owner.id }),
    })
  ).json;
  check("the one who changed it is the owner, who did", changed?.updated_by === owner.id);
  check("and the one who added it stays who it was", changed?.created_by === staff.id);

  console.log("\nwhat it was, kept");
  const events = (await O(`record_events?record_id=eq.${row.id}&order=id`)).json ?? [];
  check(
    "an add and a change are kept",
    events.length === 2 && events[0].kind === "added" && events[1].kind === "changed"
  );
  check("each with who did it", events[0]?.actor === staff.id && events[1]?.actor === owner.id);
  check(
    "and by a person",
    events.every((e) => e.via === "person")
  );
  check(
    "the change keeps what it was and what it became",
    events[1]?.before?.packed === false && events[1]?.after?.packed === true
  );
  await O(`records?id=eq.${row.id}`, {
    method: "PATCH",
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });
  check(
    "a save that changed nothing is not an event",
    ((await O(`record_events?record_id=eq.${row.id}`)).json ?? []).length === 2
  );

  console.log("\nwho may read it, and who may write it");
  check(
    "the team member who can see the section reads it",
    ((await S(`record_events?record_id=eq.${row.id}`)).json ?? []).length === 2
  );
  check("an outsider reads nothing", ((await X(`record_events?record_id=eq.${row.id}`)).json ?? []).length === 0);
  const forged = await O("record_events", {
    method: "POST",
    body: JSON.stringify({ record_id: row.id, module_id: mod.id, project_id: proj.id, via: "person", kind: "changed" }),
  });
  check("nobody writes history by hand, the owner included", !forged.ok);
  const erased = await O(`record_events?record_id=eq.${row.id}`, { method: "DELETE" });
  check("nor erases it", !erased.ok || (erased.json ?? []).length === 0);
  check("which is all still there", ((await O(`record_events?record_id=eq.${row.id}`)).json ?? []).length === 2);

  console.log("\na rule's change, and a removal");
  await O("automations", {
    method: "POST",
    body: JSON.stringify({
      project_id: proj.id,
      module_id: mod.id,
      name: "Starts unpacked",
      definition: {
        trigger: { type: "record_created" },
        actions: [{ type: "set_fields", target: { self: true }, set: { stage: { const: "To pack" } } }],
      },
    }),
  });
  const [second] = (
    await S("records", {
      method: "POST",
      body: JSON.stringify({ project_id: proj.id, module_id: mod.id, data: { order: "#1002" } }),
    })
  ).json;
  const byRule = ((await O(`record_events?record_id=eq.${second.id}&order=id`)).json ?? []).find(
    (e) => e.kind === "changed"
  );
  check(
    "the rule's change is kept, as the rule's, on their save",
    byRule?.via === "rule" && byRule?.actor === staff.id && byRule?.after?.stage === "To pack"
  );
  await O(`records?id=eq.${second.id}`, { method: "DELETE" });
  const gone = ((await O(`record_events?record_id=eq.${second.id}&order=id`)).json ?? []).at(-1);
  check("a removed row's history outlives it", gone?.kind === "removed" && gone?.before?.order === "#1002");

  console.log("\na section removed with its rows");
  // Its rows go with it, and so does their history: an event written for
  // each named a section already gone, and its foreign key refused the
  // whole delete — of the section, the app, the account.
  const del = await O(`modules?id=eq.${mod.id}`, { method: "DELETE" });
  check("the section can be removed with rows and history in it", del.ok && (del.json ?? []).length === 1);
  check("and its history goes with it", ((await O(`record_events?module_id=eq.${mod.id}`)).json ?? []).length === 0);

  console.log("\nnames for the people in the app");
  const names = await fetch(`${BASE}/rest/v1/rpc/abo_names_for`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: proj.id, p_ids: [staff.id, owner.id, outsider.id] }),
  }).then((x) => x.json());
  const byId = Object.fromEntries((Array.isArray(names) ? names : []).map((n) => [n.user_id, n.name]));
  check("a teammate is named as they said", byId[staff.id] === "Meera");
  check("the owner is named", typeof byId[owner.id] === "string" && byId[owner.id].length > 0);
  check("someone outside the app is not", !(outsider.id in byId));
  const strangers = await fetch(`${BASE}/rest/v1/rpc/abo_names_for`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${outsider.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: proj.id, p_ids: [staff.id, owner.id] }),
  }).then((x) => x.json());
  check("and an outsider is told no names", Array.isArray(strangers) && strangers.length === 0);
} finally {
  for (const u of [owner, staff, outsider]) {
    await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
  }
  console.log("\ntest users removed");
}

console.log(fails.length === 0 ? "\nwho did it is the login, and what it was is kept" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
