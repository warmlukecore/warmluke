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
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SVC) throw new Error("missing Supabase env");

const api = (jwt) => async (path, init = {}) => {
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
const O = api(owner.jwt), S = api(staff.jwt), X = api(outsider.jwt);

try {
  // Owner builds something.
  const proj = (await O("projects", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: "RLS check" }) })).json[0];
  const mod = (await O("modules", { method: "POST", body: JSON.stringify({ project_id: proj.id, name: `orders_${stamp}`, nav_label: "Orders", route: `/orders_${stamp}` }) })).json[0];
  const rec = (await O("records", { method: "POST", body: JSON.stringify({ module_id: mod.id, project_id: proj.id, data: { stage: "New" } }) })).json[0];
  const conv = (await O("conversations", { method: "POST", body: JSON.stringify({ project_id: proj.id, title: "secret" }) })).json[0];

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

  console.log("\nwhat staff CAN do — this is the point of the feature");
  check("staff sees the project", (await S(`projects?id=eq.${proj.id}`)).json.length === 1);
  check("staff sees the sections", (await S(`modules?id=eq.${mod.id}`)).json.length === 1);
  check("staff sees the rows", (await S(`records?id=eq.${rec.id}`)).json.length === 1);
  check("staff can update a row (mark it Picked)",
    (await S(`records?id=eq.${rec.id}`, { method: "PATCH", body: JSON.stringify({ data: { stage: "Picked" } }) })).json?.length === 1);
  check("staff can add a row",
    (await S("records", { method: "POST", body: JSON.stringify({ module_id: mod.id, project_id: proj.id, data: { stage: "New" } }) })).json?.length === 1);

  console.log("\nwhat staff CANNOT do");
  check("staff cannot delete a row",
    (await S(`records?id=eq.${rec.id}`, { method: "DELETE" })).json?.length === 0);
  check("the row survived that attempt", (await O(`records?id=eq.${rec.id}`)).json.length === 1);
  check("staff cannot rename a section",
    (await S(`modules?id=eq.${mod.id}`, { method: "PATCH", body: JSON.stringify({ nav_label: "Hacked" }) })).json?.length === 0);
  check("staff cannot add a section",
    !(await S("modules", { method: "POST", body: JSON.stringify({ project_id: proj.id, name: `x_${stamp}`, nav_label: "X", route: `/x_${stamp}` }) })).ok);
  check("staff cannot read the assistant thread", (await S(`conversations?id=eq.${conv.id}`)).json.length === 0);
  check("staff cannot read the rules", (await S(`automations?project_id=eq.${proj.id}`)).json.length === 0);
  check("staff cannot mint a seat for anyone",
    !(await S("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).ok);
  check("staff cannot delete the project",
    (await S(`projects?id=eq.${proj.id}`, { method: "DELETE" })).json?.length === 0);

  console.log("\ncommerce data is locked to its store the same way");
  const store = (await O("stores", { method: "POST", body: JSON.stringify({ project_id: proj.id, shop_domain: `rls-${stamp}.myshopify.com`, timezone: "Asia/Kolkata", currency: "INR" }) })).json[0];
  const cust = (await O("customers", { method: "POST", body: JSON.stringify({ store_id: store.id, external_id: `c${stamp}`, name: "Aman K", phone: "9999900000" }) })).json[0];
  const ord = (await O("orders", { method: "POST", body: JSON.stringify({ store_id: store.id, external_id: `o${stamp}`, order_number: "#1847", customer_id: cust.id, total: 2340, currency: "INR", tags: ["cod"] }) })).json[0];

  check("the owner's store saved", !!store?.id);
  check("staff can read the orders", (await S(`orders?id=eq.${ord.id}`)).json.length === 1);
  check("staff can read the customers", (await S(`customers?id=eq.${cust.id}`)).json.length === 1);
  check("staff cannot change an order",
    (await S(`orders?id=eq.${ord.id}`, { method: "PATCH", body: JSON.stringify({ total: 1 }) })).json?.length === 0);
  check("staff cannot connect or alter a store",
    (await S(`stores?id=eq.${store.id}`, { method: "PATCH", body: JSON.stringify({ shop_domain: "hijacked.myshopify.com" }) })).json?.length === 0);
  check("staff cannot read the access token",
    !(await S(`stores?id=eq.${store.id}&select=access_token`, { method: "PATCH", body: JSON.stringify({ access_token: "stolen" }) })).ok ||
      (await O(`stores?id=eq.${store.id}&select=access_token`)).json[0]?.access_token == null);

  console.log("\na Shopify connection can only be completed once");
  const rpc = (token, state) =>
    fetch(`${URL_}/rest/v1/rpc/abo_shopify_connect`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_state: state, p_token: "shpat_test", p_timezone: "Asia/Kolkata",
        p_currency: "INR", p_country: "IN",
      }),
    }).then((r) => r.json());

  const pending = (await O("stores", {
    method: "POST",
    body: JSON.stringify({
      project_id: proj.id, shop_domain: `pend-${stamp}.myshopify.com`, status: "pending",
      oauth_state: `state-${stamp}`,
      oauth_state_expires_at: new Date(Date.now() + 600000).toISOString(),
    }),
  })).json[0];
  check("a pending store was created", !!pending?.id);
  check("an unknown state connects nothing", (await rpc(owner.jwt, "made-up-state")) === null);
  check("the real state completes the connection", (await rpc(owner.jwt, `state-${stamp}`)) === proj.id);
  check("the same state cannot be used twice", (await rpc(owner.jwt, `state-${stamp}`)) === null);
  check("the store is now connected",
    (await O(`stores?id=eq.${pending.id}&select=status,timezone,oauth_state`)).json[0]?.status === "connected");
  check("the store kept its own timezone",
    (await O(`stores?id=eq.${pending.id}&select=timezone`)).json[0]?.timezone === "Asia/Kolkata");
  check("the nonce was spent",
    (await O(`stores?id=eq.${pending.id}&select=oauth_state`)).json[0]?.oauth_state === null);

  const stale = (await O("stores", {
    method: "POST",
    body: JSON.stringify({
      project_id: proj.id, shop_domain: `stale-${stamp}.myshopify.com`, status: "pending",
      oauth_state: `expired-${stamp}`,
      oauth_state_expires_at: new Date(Date.now() - 1000).toISOString(),
    }),
  })).json[0];
  check("an expired state connects nothing", (await rpc(owner.jwt, `expired-${stamp}`)) === null);
  check("the expired store stays pending",
    (await O(`stores?id=eq.${stale.id}&select=status`)).json[0]?.status === "pending");
  check("a stranger cannot complete someone else's connection",
    (await rpc(outsider.jwt, `expired-${stamp}`)) === null);

  console.log("\nanother merchant's commerce is invisible");
  check("outsider sees no store", (await X(`stores?id=eq.${store.id}`)).json.length === 0);
  check("outsider sees no orders", (await X(`orders?id=eq.${ord.id}`)).json.length === 0);
  check("outsider sees no customers", (await X(`customers?id=eq.${cust.id}`)).json.length === 0);
  check("outsider cannot insert into someone else's store",
    !(await X("orders", { method: "POST", body: JSON.stringify({ store_id: store.id, external_id: "x", total: 1 }) })).ok);

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

console.log(fails.length === 0 ? "\nall boundaries hold" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
