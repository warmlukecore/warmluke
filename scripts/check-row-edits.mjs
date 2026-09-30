// A save lands on the row it saw, or says what changed (0149).
//
// Two people with the same row open used to lose each other's changes:
// each save read the row, merged in the app and wrote the whole row
// back. This saves at the same moment, from two people, through the
// database function and through the app's own door, and asks what is
// left on the row.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node scripts/check-row-edits.mjs

import { readFileSync } from "node:fs";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const SVC = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
const APP = process.env.APP_URL ?? "http://localhost:3100";
if (!URL_ || !ANON || !SVC) throw new Error("missing Supabase env");
if (env.CHECK_PROJECT !== "1") throw new Error(`${envFile} is not the check project's; this writes`);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const headers = (jwt) => ({
  apikey: ANON,
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});
const rest =
  (jwt) =>
  async (path, init = {}) => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: headers(jwt) });
    const t = await r.text();
    return { ok: r.ok, status: r.status, json: t ? JSON.parse(t) : null };
  };
async function signup(email) {
  const j = await fetch(`${URL_}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test-passw0rd!" }),
  }).then((r) => r.json());
  if (!j.access_token) throw new Error(`signup failed: ${JSON.stringify(j)}`);
  return { jwt: j.access_token, id: j.user.id };
}

const stamp = Date.now();
const owner = await signup(`edits-owner-${stamp}@warmluke.test`);
const outsider = await signup(`edits-out-${stamp}@warmluke.test`);
const O = rest(owner.jwt);
const patch = (as, record, fields, seen = null) =>
  rest(as.jwt)("rpc/abo_record_patch", {
    method: "POST",
    body: JSON.stringify({ p_record: record, p_patch: fields, p_expected: seen }),
  }).then((r) => r.json);
const row = async (id) => (await O(`records?id=eq.${id}&select=data`)).json?.[0]?.data;

try {
  const proj = (await O("projects", { method: "POST", body: JSON.stringify({ name: `edits ${stamp}` }) })).json[0];
  const mod = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `dispatch_${stamp}`,
        nav_label: "Dispatch",
        route: `/d_${stamp}`,
      }),
    })
  ).json[0];
  await O("ui_schemas", {
    method: "POST",
    body: JSON.stringify({
      module_id: mod.id,
      version: 1,
      created_by: "user",
      schema_json: {
        columns: [
          { field: "status", label: "Status", type: "dropdown", options: ["Packed", "Shipped", "Cancelled"] },
          { field: "note", label: "Note", type: "text" },
          { field: "courier", label: "Courier", type: "text" },
        ],
      },
    }),
  });
  const made = (
    await O("records", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        module_id: mod.id,
        data: { status: "Packed", note: "", courier: "" },
      }),
    })
  ).json[0];

  console.log("two people save different fields of one row at the same moment");
  await Promise.all([patch(owner, made.id, { note: "fragile" }), patch(owner, made.id, { courier: "Delhivery" })]);
  const both = await row(made.id);
  check("both changes are on the row", both?.note === "fragile" && both?.courier === "Delhivery");
  check("and what neither touched is as it was", both?.status === "Packed");

  console.log("\ntwo people change the same field, each from what they saw");
  const first = await patch(owner, made.id, { status: "Shipped" }, { status: "Packed" });
  check("the first lands", first?.status === "applied" && first?.before?.status === "Packed");
  const second = await patch(owner, made.id, { status: "Cancelled" }, { status: "Packed" });
  check(
    "the second is refused, saying what it is now",
    second?.status === "conflict" && second?.now?.status === "Shipped"
  );
  check("and the row keeps the first", (await row(made.id))?.status === "Shipped");

  console.log("\nthe same save, sent twice");
  const again = await patch(owner, made.id, { status: "Shipped" }, { status: "Packed" });
  check("lands as landed, not as a clash with itself", again?.status === "applied");
  const events = (await O(`record_events?record_id=eq.${made.id}&kind=eq.changed&select=after`)).json ?? [];
  check("and is one change in the history, not two", events.filter((e) => e.after?.status === "Shipped").length === 1);

  console.log("\nwhat is not there, and who may not");
  check(
    "an outsider's save finds no row",
    (await patch(outsider, made.id, { status: "Cancelled" }))?.status === "missing"
  );
  check("and changes nothing", (await row(made.id))?.status === "Shipped");
  const gone = (
    await O("records", {
      method: "POST",
      body: JSON.stringify({ project_id: proj.id, module_id: mod.id, data: { status: "Packed" } }),
    })
  ).json[0];
  await O(`records?id=eq.${gone.id}`, { method: "DELETE" });
  check(
    "a row deleted meanwhile is said to be gone",
    (await patch(owner, gone.id, { status: "Shipped" }))?.status === "missing"
  );

  console.log("\nthrough the app's own door");
  const door = (body) =>
    fetch(`${APP}/api/records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", projectId: proj.id, moduleId: mod.id, recordId: made.id, ...body }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const clash = await door({ data: { status: "Cancelled" }, expected: { status: "Packed" } });
  check("a save from an old screen is answered 409", clash.status === 409 && clash.json?.conflict === true);
  check("naming the field by its label and what it is now", /Status is now “Shipped”/.test(clash.json?.error ?? ""));
  check("with the row as it stands, for the screen to show", clash.json?.record?.data?.status === "Shipped");
  const fromNow = await door({ data: { status: "Cancelled" }, expected: { status: "Shipped" } });
  check(
    "saved again from what is there now, it lands",
    fromNow.status === 200 && fromNow.json?.record?.data?.status === "Cancelled"
  );
  const [a, b] = await Promise.all([door({ data: { note: "two boxes" } }), door({ data: { courier: "Shiprocket" } })]);
  const last = await row(made.id);
  check(
    "two saves of different fields at once, through the app, both stay",
    a.status === 200 && b.status === 200 && last?.note === "two boxes" && last?.courier === "Shiprocket"
  );
} finally {
  for (const u of [owner, outsider]) {
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
  }
  console.log("\ntest users removed");
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED`);
  process.exit(1);
}
console.log("\na save lands on the row it saw, or says what changed");
