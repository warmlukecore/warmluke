// RLS boundary check.
//
// Staff logins are enforced by database policies alone — no API route
// checks an owner. That makes the policies the whole security model, and
// a silently-loosened one would not fail any other test in this repo.
// This creates a real owner, a real staff member, and tries every door.
//
//   node scripts/check-rls.mjs

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SVC) throw new Error("missing Supabase env");

const api =
  (jwt) =>
  async (path, init = {}) => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, {
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

async function signup(email) {
  const r = await fetch(`${URL_}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test-passw0rd!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`signup failed: ${JSON.stringify(j)}`);
  return { jwt: j.access_token, id: j.user.id, email };
}

const fails = [];
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}`);
    fails.push(name);
  }
};

const stamp = Date.now();
const owner = await signup(`rls-owner-${stamp}@warmluke.test`);
const staff = await signup(`rls-staff-${stamp}@warmluke.test`);
const outsider = await signup(`rls-out-${stamp}@warmluke.test`);
const O = api(owner.jwt),
  S = api(staff.jwt),
  X = api(outsider.jwt);

try {
  // Owner builds something.
  const proj = (
    await O("projects", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: "RLS check" }) })
  ).json[0];
  const mod = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `orders_${stamp}`,
        nav_label: "Orders",
        route: `/orders_${stamp}`,
      }),
    })
  ).json[0];
  const rec = (
    await O("records", {
      method: "POST",
      body: JSON.stringify({ module_id: mod.id, project_id: proj.id, data: { stage: "New" } }),
    })
  ).json[0];
  const conv = (
    await O("conversations", { method: "POST", body: JSON.stringify({ project_id: proj.id, title: "secret" }) })
  ).json[0];

  console.log("\nbefore joining — a stranger sees nothing");
  check("staff cannot see the project", (await S(`projects?id=eq.${proj.id}`)).json.length === 0);
  check("staff cannot see the sections", (await S(`modules?id=eq.${mod.id}`)).json.length === 0);
  check("staff cannot see the rows", (await S(`records?id=eq.${rec.id}`)).json.length === 0);

  // Owner opens a seat; staff claims it with the token.
  const seat = (await O("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).json[0];
  const joined = await fetch(`${URL_}/rest/v1/rpc/abo_join`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: seat.token }),
  }).then((r) => r.json());

  console.log("\njoining");
  check("the link lets staff in", joined === proj.id);
  const badToken = await fetch(`${URL_}/rest/v1/rpc/abo_join`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${outsider.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: "not-a-real-token" }),
  }).then((r) => r.json());
  check("a wrong token lets nobody in", badToken === null);
  const stolen = await fetch(`${URL_}/rest/v1/rpc/abo_join`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${outsider.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: seat.token }),
  }).then((r) => r.json());
  check("a used link cannot be taken by someone else", stolen === null);

  console.log("\nand who joined, in their own words (0118)");
  const about = (jwt, body) =>
    fetch(`${URL_}/rest/v1/rpc/abo_member_about`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  check(
    "staff can say who they are on the team",
    (await about(staff.jwt, { p_project: proj.id, p_name: " Meera ", p_role: "warehouse" })).ok
  );
  const told = (await O(`project_members?id=eq.${seat.id}&select=full_name,team_role`)).json?.[0];
  check("and the owner sees it on the seat", told?.full_name === "Meera" && told?.team_role === "warehouse");
  check(
    "a role off the list is refused",
    !(await about(staff.jwt, { p_project: proj.id, p_name: "Meera", p_role: "ceo" })).ok
  );
  check(
    "an outsider cannot write themselves onto the team",
    !(await about(outsider.jwt, { p_project: proj.id, p_name: "Nobody", p_role: "other" })).ok
  );

  console.log("\na section is the owner's until it is shared (0140)");
  check("staff sees the project", (await S(`projects?id=eq.${proj.id}`)).json.length === 1);
  check("but not a section nobody shared with them", (await S(`modules?id=eq.${mod.id}`)).json.length === 0);
  check("nor its rows", (await S(`records?id=eq.${rec.id}`)).json.length === 0);
  check(
    "nor can they add a row to it",
    !(
      await S("records", {
        method: "POST",
        body: JSON.stringify({ module_id: mod.id, project_id: proj.id, data: { stage: "New" } }),
      })
    ).ok
  );
  const share = (body) => O(`modules?id=eq.${mod.id}`, { method: "PATCH", body: JSON.stringify(body) });
  await share({ shared_with_team: true });
  check("shared with the team, they see it", (await S(`modules?id=eq.${mod.id}`)).json.length === 1);
  await share({ shared_with_team: false });
  check("taken back, it is gone again", (await S(`modules?id=eq.${mod.id}`)).json.length === 0);
  check(
    "the owner can share it with the one person",
    (await O("module_shares", { method: "POST", body: JSON.stringify({ module_id: mod.id, member_id: seat.id }) })).ok
  );
  check("who then sees it", (await S(`modules?id=eq.${mod.id}`)).json.length === 1);
  const child = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        parent_id: mod.id,
        name: `inside_${stamp}`,
        nav_label: "Inside",
        route: `/inside_${stamp}`,
      }),
    })
  ).json[0];
  check("and a section inside it, shared as its parent is", (await S(`modules?id=eq.${child.id}`)).json.length === 1);
  const secret = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `margins_${stamp}`,
        nav_label: "Margins",
        route: `/m_${stamp}`,
      }),
    })
  ).json[0];
  check("another section stays the owner's", (await S(`modules?id=eq.${secret.id}`)).json.length === 0);
  check(
    "staff cannot share a section with themselves",
    !(await S("module_shares", { method: "POST", body: JSON.stringify({ module_id: secret.id, member_id: seat.id }) }))
      .ok
  );
  check(
    "nor open one to the team",
    (await S(`modules?id=eq.${secret.id}`, { method: "PATCH", body: JSON.stringify({ shared_with_team: true }) })).json
      ?.length === 0
  );
  check(
    "nor give themselves the store",
    (await S(`project_members?id=eq.${seat.id}`, { method: "PATCH", body: JSON.stringify({ can_see_store: true }) }))
      .json?.length === 0
  );
  const stats = await fetch(`${URL_}/rest/v1/rpc/abo_section_stats`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_module: secret.id, p_stats: [] }),
  });
  check("nor count the rows of one not shared with them", !stats.ok);

  console.log("\nhidden from one person wins (0145)");
  check(
    "a section says who built it",
    (await O(`modules?id=eq.${secret.id}&select=created_by`)).json[0]?.created_by === owner.id
  );
  const forged = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `forged_${stamp}`,
        nav_label: "Forged",
        route: `/f_${stamp}`,
        created_by: staff.id,
      }),
    })
  ).json[0];
  check("and what was sent as the builder is not taken", forged?.created_by === owner.id);
  check("so the one it was sent for does not see it", (await S(`modules?id=eq.${forged?.id}`)).json.length === 0);
  const hide = () =>
    O("module_hides", { method: "POST", body: JSON.stringify({ module_id: mod.id, member_id: seat.id }) });
  check("the owner can hide a section shared with them by name", (await hide()).ok);
  check("which is then gone for them", (await S(`modules?id=eq.${mod.id}`)).json.length === 0);
  check("and the section inside it with it", (await S(`modules?id=eq.${child.id}`)).json.length === 0);
  await share({ shared_with_team: true });
  check("shared with the whole team, still hidden from them", (await S(`modules?id=eq.${mod.id}`)).json.length === 0);
  check(
    "they read their own hide, so their screen hears it",
    (await S(`module_hides?module_id=eq.${mod.id}`)).json.length === 1
  );
  check("and their own share", (await S(`module_shares?module_id=eq.${mod.id}`)).json.length === 1);
  await S(`module_hides?module_id=eq.${mod.id}`, { method: "DELETE" });
  check(
    "they cannot take the hide away themselves",
    (await O(`module_hides?module_id=eq.${mod.id}`)).json.length === 1
  );
  check(
    "nor hide something from someone else",
    !(await S("module_hides", { method: "POST", body: JSON.stringify({ module_id: secret.id, member_id: seat.id }) }))
      .ok
  );
  check("an outsider reads no one's hides", (await X(`module_hides?module_id=eq.${mod.id}`)).json.length === 0);
  await O(`module_hides?module_id=eq.${mod.id}&member_id=eq.${seat.id}`, { method: "DELETE" });
  check("the owner takes it away, and they see it again", (await S(`modules?id=eq.${mod.id}`)).json.length === 1);
  await share({ shared_with_team: false });

  console.log("\na team that builds (0146)");
  const call = (jwt, fn, body) =>
    fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const build = (as, op, payload, request = null) =>
    fetch(`${URL_}/rest/v1/rpc/abo_build`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${as.jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_project: proj.id, p_request: request, p_op: op, p_payload: payload }),
    }).then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => null) }));
  const newSection = (name) => ({ name, nav_label: name, route: `/${name}` });
  check("someone not let build cannot build", !(await build(staff, "module_insert", newSection(`no_${stamp}`))).ok);
  check(
    "nor switch it on for themselves",
    (await S(`project_members?id=eq.${seat.id}`, { method: "PATCH", body: JSON.stringify({ can_build: true }) })).json
      ?.length === 0
  );
  check(
    "the owner switches it on",
    (await O(`project_members?id=eq.${seat.id}`, { method: "PATCH", body: JSON.stringify({ can_build: true }) })).json
      ?.length === 1
  );
  const built = await build(staff, "module_insert", newSection(`theirs_${stamp}`));
  const theirs = built.json?.id;
  check("then they build a section", built.ok && !!theirs);
  check(
    "which says they built it",
    (await O(`modules?id=eq.${theirs}&select=created_by`)).json[0]?.created_by === staff.id
  );
  check("and they see it without it being shared", (await S(`modules?id=eq.${theirs}`)).json.length === 1);
  check(
    "they design it",
    (await build(staff, "schema_insert", { module_id: theirs, schema_json: { columns: [] }, version: 1 })).ok
  );
  check(
    "but not a section the owner built",
    !(await build(staff, "schema_insert", { module_id: mod.id, schema_json: { columns: [] }, version: 9 })).ok
  );
  check(
    "nor put one of theirs inside it",
    !(await build(staff, "module_insert", { ...newSection(`under_${stamp}`), parent_id: secret.id })).ok
  );
  check(
    "they add a rule to what they built",
    (
      await build(staff, "automation_insert", {
        module_id: theirs,
        name: "Flag it",
        definition: { trigger: { type: "record_created" }, actions: [] },
      })
    ).ok
  );
  check(
    "not one over the whole app",
    !(
      await build(staff, "automation_insert", {
        module_id: null,
        name: "Everywhere",
        definition: { trigger: { type: "record_created" }, actions: [] },
      })
    ).ok
  );
  check("and read the rules they made", (await S(`automations?module_id=eq.${theirs}`)).json.length === 1);
  const direct = (
    await S("modules", {
      method: "POST",
      body: JSON.stringify({ project_id: proj.id, name: `direct_${stamp}`, nav_label: "Direct", route: `/d_${stamp}` }),
    })
  ).json?.[0];
  check("the New section button works for them too", direct?.created_by === staff.id);
  check(
    "they share what they built with the team",
    (await S(`modules?id=eq.${theirs}`, { method: "PATCH", body: JSON.stringify({ shared_with_team: true }) })).json
      ?.length === 1
  );
  check(
    "but cannot rename the owner's",
    (await S(`modules?id=eq.${mod.id}`, { method: "PATCH", body: JSON.stringify({ nav_label: "Mine now" }) })).json
      ?.length === 0
  );
  const other = (await O("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).json[0];
  const mates = await call(staff.jwt, "abo_teammates", { p_project: proj.id });
  check(
    "they see who is on the team, without anyone's link",
    Array.isArray(mates) && mates.length === 2 && mates.every((m) => !("token" in m))
  );
  check(
    "an outsider sees nobody",
    ((await call(outsider.jwt, "abo_teammates", { p_project: proj.id })) ?? []).length === 0
  );
  check(
    "they share what they built with one person",
    (await S("module_shares", { method: "POST", body: JSON.stringify({ module_id: theirs, member_id: other.id }) })).ok
  );
  check(
    "not the owner's",
    !(await S("module_shares", { method: "POST", body: JSON.stringify({ module_id: secret.id, member_id: other.id }) }))
      .ok
  );
  check(
    "they switch one person off what they built",
    (await S("module_hides", { method: "POST", body: JSON.stringify({ module_id: theirs, member_id: other.id }) })).ok
  );
  check(
    "but not themselves",
    !(await S("module_hides", { method: "POST", body: JSON.stringify({ module_id: direct.id, member_id: seat.id }) }))
      .ok
  );
  await O("module_hides", { method: "POST", body: JSON.stringify({ module_id: direct.id, member_id: seat.id }) });
  check("the owner hides what they built from them", (await S(`modules?id=eq.${direct.id}`)).json.length === 0);
  check(
    "and then it is not theirs to change",
    !(await build(staff, "module_update", { module_id: direct.id, nav_label: "Back" })).ok
  );
  await S(`module_hides?module_id=eq.${direct.id}`, { method: "DELETE" });
  check(
    "nor theirs to take the hide away",
    (await O(`module_hides?module_id=eq.${direct.id}&member_id=eq.${seat.id}`)).json.length === 1
  );
  check("the owner sees everything they built", (await O(`modules?created_by=eq.${staff.id}`)).json.length === 2);

  const ownerThread = (
    await O("conversations", { method: "POST", body: JSON.stringify({ project_id: proj.id, title: "Margins" }) })
  ).json[0];
  const staffThread = (
    await S("conversations", { method: "POST", body: JSON.stringify({ project_id: proj.id, title: "Packing" }) })
  ).json?.[0];
  check("they talk to Luke in a thread of their own", staffThread?.created_by === staff.id);
  check(
    "they write in it",
    (
      await S("messages", {
        method: "POST",
        body: JSON.stringify({ conversation_id: staffThread?.id, role: "user", content: "hi" }),
      })
    ).ok
  );
  check("the owner reads it", (await O(`conversations?id=eq.${staffThread?.id}`)).json.length === 1);
  check("they cannot read the owner's", (await S(`conversations?id=eq.${ownerThread.id}`)).json.length === 0);
  check(
    "nor write in it",
    !(
      await S("messages", {
        method: "POST",
        body: JSON.stringify({ conversation_id: ownerThread.id, role: "user", content: "hi" }),
      })
    ).ok
  );

  const turnsOf = async (as, id) =>
    (await api(as.jwt)(`account_settings?user_id=eq.${id}&select=turns_used`)).json?.[0]?.turns_used ?? 0;
  const [ownerBefore, staffBefore] = [await turnsOf(owner, owner.id), await turnsOf(staff, staff.id)];
  const spent = await call(staff.jwt, "abo_spend_turn", { p_project: proj.id });
  check(
    "a design they ask for is paid from the owner's",
    spent?.ok === true && (await turnsOf(owner, owner.id)) === ownerBefore + 1
  );
  check("not their own", (await turnsOf(staff, staff.id)) === staffBefore);
  await call(staff.jwt, "abo_refund_turn", { p_spend: spent?.spend_id });
  check("and one that made nothing is given back to the owner", (await turnsOf(owner, owner.id)) === ownerBefore);
  check(
    "an outsider cannot spend the owner's",
    (await call(outsider.jwt, "abo_spend_turn", { p_project: proj.id }))?.ok !== true &&
      (await turnsOf(owner, owner.id)) === ownerBefore
  );

  await O(`project_members?id=eq.${seat.id}`, { method: "PATCH", body: JSON.stringify({ can_build: false }) });
  check("switched off, they still see what they built", (await S(`modules?id=eq.${theirs}`)).json.length === 1);
  check(
    "but no longer change it",
    !(await build(staff, "module_update", { module_id: theirs, nav_label: "Again" })).ok
  );
  check("nor read their threads", (await S(`conversations?id=eq.${staffThread?.id}`)).json.length === 0);
  check(
    "nor spend the owner's",
    (await call(staff.jwt, "abo_spend_turn", { p_project: proj.id }))?.ok !== true &&
      (await turnsOf(owner, owner.id)) === ownerBefore
  );
  check("an outsider cannot build here at all", !(await build(outsider, "module_insert", newSection(`x_${stamp}`))).ok);

  console.log("\nwhat Luke knows is the owner's (0140)");
  await O("merchant_notes", { method: "POST", body: JSON.stringify({ project_id: proj.id, note: "Margins are 40%" }) });
  await O("turn_traces", {
    method: "POST",
    body: JSON.stringify({ project_id: proj.id, plan_goal: "A margin sheet" }),
  });
  check(
    "the owner keeps notes about the business",
    (await O(`merchant_notes?project_id=eq.${proj.id}`)).json.length === 1
  );
  check("staff cannot read them", (await S(`merchant_notes?project_id=eq.${proj.id}`)).json.length === 0);
  check("nor what Luke's turns were about", (await S(`turn_traces?project_id=eq.${proj.id}`)).json.length === 0);

  console.log("\nthe link itself (0140)");
  const rpcAs = (jwt, fn, body) =>
    fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const spare = (await O("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).json[0];
  check(
    "the owner opening their own link goes in",
    (await rpcAs(owner.jwt, "abo_join", { p_token: spare.token })) === proj.id
  );
  check(
    "someone already on the team goes in",
    (await rpcAs(staff.jwt, "abo_join", { p_token: spare.token })) === proj.id
  );
  check(
    "and neither uses the link up",
    (await O(`project_members?id=eq.${spare.id}&select=user_id`)).json[0]?.user_id === null
  );
  const old = (
    await O("project_members", {
      method: "POST",
      body: JSON.stringify({ project_id: proj.id, expires_at: new Date(Date.now() - 1000).toISOString() }),
    })
  ).json[0];
  check("an expired link lets nobody in", (await rpcAs(outsider.jwt, "abo_join", { p_token: old.token })) === null);
  const welcome = await rpcAs(staff.jwt, "abo_seat_welcome", { p_project: proj.id });
  check(
    "who joined is told who invited them and what they will find",
    typeof welcome?.invited_by === "string" &&
      welcome.sections?.includes("Orders") &&
      !welcome.sections.includes("Margins")
  );
  check(
    "an outsider is told nothing",
    await fetch(`${URL_}/rest/v1/rpc/abo_seat_welcome`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${outsider.jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_project: proj.id }),
    }).then((r) => !r.ok)
  );

  console.log("\nwhat staff CAN do with what is shared — this is the point of the feature");
  check("staff sees the sections", (await S(`modules?id=eq.${mod.id}`)).json.length === 1);
  check("staff sees the rows", (await S(`records?id=eq.${rec.id}`)).json.length === 1);
  check(
    "staff can update a row (mark it Picked)",
    (await S(`records?id=eq.${rec.id}`, { method: "PATCH", body: JSON.stringify({ data: { stage: "Picked" } }) })).json
      ?.length === 1
  );
  check(
    "staff can add a row",
    (
      await S("records", {
        method: "POST",
        body: JSON.stringify({ module_id: mod.id, project_id: proj.id, data: { stage: "New" } }),
      })
    ).json?.length === 1
  );

  console.log("\nwhat staff CANNOT do");
  check("staff cannot delete a row", (await S(`records?id=eq.${rec.id}`, { method: "DELETE" })).json?.length === 0);
  check("the row survived that attempt", (await O(`records?id=eq.${rec.id}`)).json.length === 1);
  check(
    "staff cannot rename a section",
    (await S(`modules?id=eq.${mod.id}`, { method: "PATCH", body: JSON.stringify({ nav_label: "Hacked" }) })).json
      ?.length === 0
  );
  check(
    "staff cannot add a section",
    !(
      await S("modules", {
        method: "POST",
        body: JSON.stringify({ project_id: proj.id, name: `x_${stamp}`, nav_label: "X", route: `/x_${stamp}` }),
      })
    ).ok
  );
  check("staff cannot read the assistant thread", (await S(`conversations?id=eq.${conv.id}`)).json.length === 0);
  check("staff cannot read the rules", (await S(`automations?project_id=eq.${proj.id}`)).json.length === 0);
  check(
    "staff cannot mint a seat for anyone",
    !(await S("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).ok
  );
  check(
    "staff cannot delete the project",
    (await S(`projects?id=eq.${proj.id}`, { method: "DELETE" })).json?.length === 0
  );

  console.log("\ncommerce data is locked to its store the same way");
  // select=id, not the default representation: since 0046 the token
  // columns are not selectable by anyone, so asking for the whole row
  // back is a permission error rather than a store.
  const store = (
    await O("stores?select=id", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        shop_domain: `rls-${stamp}.myshopify.com`,
        timezone: "Asia/Kolkata",
        currency: "INR",
      }),
    })
  ).json[0];
  const cust = (
    await O("customers", {
      method: "POST",
      body: JSON.stringify({ store_id: store.id, external_id: `c${stamp}`, name: "Aman K", phone: "9999900000" }),
    })
  ).json[0];
  const ord = (
    await O("orders", {
      method: "POST",
      body: JSON.stringify({
        store_id: store.id,
        external_id: `o${stamp}`,
        order_number: "#1847",
        customer_id: cust.id,
        total: 2340,
        currency: "INR",
        tags: ["cod"],
      }),
    })
  ).json[0];

  check("the owner's store saved", !!store?.id);
  // A seat starts without the store (0140): the customers' phones are not
  // every packer's until the owner says so.
  check("a new seat does not read the orders", (await S(`orders?id=eq.${ord.id}`)).json.length === 0);
  check("nor the customers", (await S(`customers?id=eq.${cust.id}`)).json.length === 0);
  check("nor sees a store at all", (await S(`stores?id=eq.${store.id}&select=id`)).json.length === 0);
  const overview = await fetch(`${URL_}/rest/v1/rpc/abo_store_overview`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${staff.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: proj.id }),
  });
  check("nor its figures", !overview.ok);
  check(
    "the owner lets them see the store",
    (await O(`project_members?id=eq.${seat.id}`, { method: "PATCH", body: JSON.stringify({ can_see_store: true }) }))
      .json?.length === 1
  );
  check("staff can read the orders", (await S(`orders?id=eq.${ord.id}`)).json.length === 1);
  check("staff can read the customers", (await S(`customers?id=eq.${cust.id}`)).json.length === 1);
  check(
    "staff cannot change an order",
    (await S(`orders?id=eq.${ord.id}`, { method: "PATCH", body: JSON.stringify({ total: 1 }) })).json?.length === 0
  );
  check(
    "staff cannot connect or alter a store",
    (
      await S(`stores?id=eq.${store.id}&select=id`, {
        method: "PATCH",
        body: JSON.stringify({ shop_domain: "hijacked.myshopify.com" }),
      })
    ).json?.length === 0
  );
  // The dashboard hides Disconnect from staff, but that is only a label.
  // Disconnecting deletes the store and cascades to every order and
  // customer under it, so the real refusal has to be here.
  check(
    "staff cannot disconnect the store",
    (await S(`stores?id=eq.${store.id}&select=id`, { method: "DELETE" })).json?.length === 0
  );
  check("the store survived that attempt", (await O(`stores?id=eq.${store.id}&select=id`)).json.length === 1);
  check(
    "staff cannot write the access token",
    !(
      await S(`stores?id=eq.${store.id}&select=id`, {
        method: "PATCH",
        body: JSON.stringify({ access_token: "stolen" }),
      })
    ).ok || (await O(`stores?id=eq.${store.id}&select=id`)).json.length === 1
  );
  // Nor read it — RLS decides rows, so this is a column privilege and
  // it refuses the owner too. check-store-token covers it in full.
  check(
    "and nobody reads it as a column",
    !(await S(`stores?id=eq.${store.id}&select=access_token`)).ok &&
      !(await O(`stores?id=eq.${store.id}&select=access_token`)).ok
  );

  console.log("\na Shopify connection can only be completed once");
  // p_shop joined the signature: the nonce says which attempt this is,
  // the shop says which store came back, and both have to agree or a
  // token lands on a row naming somebody else's shop.
  const rpc = (token, state, shop = `pend-${stamp}.myshopify.com`) =>
    fetch(`${URL_}/rest/v1/rpc/abo_shopify_connect`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_state: state,
        p_shop: shop,
        p_token: "shpat_test",
        p_timezone: "Asia/Kolkata",
        p_currency: "INR",
        p_country: "IN",
        // Shopify tokens expire now, so the connect function stores the
        // refresh token and both lifetimes alongside the access token.
        p_refresh_token: "shprt_test",
        p_expires_in: 3600,
        p_refresh_expires_in: 7776000,
        // And what the grant came with, so a reconnect that granted
        // less than the last one shows as less.
        p_scopes: ["read_orders", "read_products"],
      }),
    }).then((r) => r.json());

  const pending = (
    await O("stores?select=id", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        shop_domain: `pend-${stamp}.myshopify.com`,
        status: "pending",
        oauth_state: `state-${stamp}`,
        oauth_state_expires_at: new Date(Date.now() + 600000).toISOString(),
      }),
    })
  ).json[0];
  check("a pending store was created", !!pending?.id);
  check("an unknown state connects nothing", (await rpc(owner.jwt, "made-up-state")) === null);
  check("the real state completes the connection", (await rpc(owner.jwt, `state-${stamp}`)) === proj.id);
  check("the same state cannot be used twice", (await rpc(owner.jwt, `state-${stamp}`)) === null);
  check(
    "a callback naming a different shop connects nothing",
    (await rpc(owner.jwt, `state-${stamp}`, "someone-else.myshopify.com")) === null
  );
  check(
    "the store is now connected",
    (await O(`stores?id=eq.${pending.id}&select=status,timezone`)).json[0]?.status === "connected"
  );
  check(
    "the store kept its own timezone",
    (await O(`stores?id=eq.${pending.id}&select=timezone`)).json[0]?.timezone === "Asia/Kolkata"
  );
  // The nonce is not selectable since 0046 — it is a secret like the
  // token. That it was spent is what the line above already proves:
  // the same state connected nothing the second time.
  check("and the nonce is not readable either", !(await O(`stores?id=eq.${pending.id}&select=oauth_state`)).ok);

  const stale = (
    await O("stores?select=id", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        shop_domain: `stale-${stamp}.myshopify.com`,
        status: "pending",
        oauth_state: `expired-${stamp}`,
        oauth_state_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    })
  ).json[0];
  check("an expired state connects nothing", (await rpc(owner.jwt, `expired-${stamp}`)) === null);
  check(
    "the expired store stays pending",
    (await O(`stores?id=eq.${stale.id}&select=status`)).json[0]?.status === "pending"
  );
  check("a stranger cannot complete someone else's connection", (await rpc(outsider.jwt, `expired-${stamp}`)) === null);

  console.log("\nanother merchant's commerce is invisible");
  check("outsider sees no store", (await X(`stores?id=eq.${store.id}&select=id`)).json.length === 0);
  check("outsider sees no orders", (await X(`orders?id=eq.${ord.id}`)).json.length === 0);
  check("outsider sees no customers", (await X(`customers?id=eq.${cust.id}`)).json.length === 0);
  check(
    "outsider cannot insert into someone else's store",
    !(await X("orders", { method: "POST", body: JSON.stringify({ store_id: store.id, external_id: "x", total: 1 }) }))
      .ok
  );

  // The newest table naming a merchant's shop, and the only one that
  // says what is about to be CHANGED there. A stranger reading it
  // learns their business; a stranger writing one would be proposing
  // changes to somebody else's store. Inserted with the service key
  // because nobody may insert at this table — not even its owner,
  // who goes through abo_action_propose.
  const svc = api(SVC);
  const act = (
    await svc("store_actions", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        store_id: store.id,
        requested_by: owner.id,
        action: "tag_orders",
        summary: "Tags one order",
        targets: [],
        params: {},
      }),
    })
  ).json[0];
  check("outsider sees no store action", (await X(`store_actions?id=eq.${act.id}`)).json.length === 0);
  check("the owner does see their own", (await O(`store_actions?id=eq.${act.id}`)).json.length === 1);
  check(
    "and nobody writes one at the table",
    !(
      await O("store_actions", {
        method: "POST",
        body: JSON.stringify({
          project_id: proj.id,
          store_id: store.id,
          requested_by: owner.id,
          action: "tag_orders",
          summary: "By hand",
          targets: [],
          params: {},
        }),
      })
    ).ok
  );

  console.log("\nan outsider is still shut out");
  check("outsider sees no project", (await X(`projects?id=eq.${proj.id}`)).json.length === 0);
  check("outsider sees no rows", (await X(`records?id=eq.${rec.id}`)).json.length === 0);
} finally {
  // Test accounts are not a thing to leave lying in a real database.
  for (const u of [owner, staff, outsider]) {
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
  }
  console.log("\ntest users removed");
}

// And the wall covers the whole house.
//
// 0028 refused every write from a token carrying client_id by looping
// over the tables that existed THEN. Six tables added afterwards had
// none of it — including build_requests, where a client could write
// its own approved_at and walk straight through the gate that exists
// to stop exactly that.
//
// A loop fixes today. This asserts tomorrow: the next table added
// without the three policies fails here instead of sitting open and
// quiet until somebody goes looking.
console.log("\nand no table is left outside the wall");
{
  const naked = await fetch(`${URL_}/rest/v1/rpc/abo_tables_missing_oauth_guard`, {
    method: "POST",
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" },
    body: "{}",
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  // The function is the check's own business; if it is missing, say so
  // rather than passing because nothing answered.
  check("every table can be asked about", Array.isArray(naked));
  check("and every one of them refuses writes from an AI's token", Array.isArray(naked) && naked.length === 0);
  if (Array.isArray(naked) && naked.length > 0) {
    for (const t of naked) console.log(`     ..    unguarded: ${t.tablename ?? t}`);
  }
}

// ── A project id that is not yours ──────────────────────────────
//
// Editing two characters of the uuid in /app/<id> showed the empty
// "Start building" workspace. No row ever crossed the boundary — RLS
// refused every one — but the SCREEN said more than the database did,
// and it read exactly like somebody else's app had opened.
//
// Two halves, and both have to hold: the data side, checked live here,
// and the shell's reading of an empty answer, checked in its source.
// The second is read rather than driven because reaching that screen
// in a browser needs a real session, and minting one to assert a
// five-line condition is not worth putting an access token on disk.
console.log("\na project id that is not yours");
{
  // Asked as the outsider this check already created, which is exactly
  // who a tampered url is being opened by.
  const nowhere = "00000000-0000-4000-8000-000000000000";
  const none = await X(`projects?id=eq.${nowhere}&select=id`);
  check("an id nobody owns returns no rows", Array.isArray(none.json) && none.json.length === 0);
  // A real project that is not theirs is already covered above, where
  // the outsider is refused the one the owner just built.

  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  // Two states cannot tell "still loading" from "nothing there", which
  // is the whole bug: null meant both, and both rendered the app.
  check(
    "the shell can tell 'not asked yet' from 'nothing came back'",
    /useState<ProjectRow \| null \| undefined>\(undefined\)/.test(shell)
  );
  check("and renders a refusal rather than an empty workspace", /if \(project === null\) \{/.test(shell));
  // One screen for "does not exist" and "not yours". Telling them
  // apart is how an outsider learns which ids are real.
  // Scoped to that screen's own copy, not the whole file: "does not
  // exist" is ordinary wording elsewhere in a 1600-line component, and
  // a check that greps everything fails for the wrong reason.
  const refusal = shell.slice(shell.indexOf("if (project === null) {"), shell.indexOf("<FormatProvider"));
  check(
    "that says the same thing either way",
    /isn&rsquo;t available/.test(refusal) && !/(does not exist|doesn&rsquo;t exist|not found|no such)/i.test(refusal)
  );
  check("and offers a way back", /\/dashboard/.test(refusal));
}

console.log(fails.length === 0 ? "\nall boundaries hold" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
