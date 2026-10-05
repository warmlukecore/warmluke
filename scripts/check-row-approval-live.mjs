// A button that waits for the owner (0183, app/api/row-action, #6, 5 Oct),
// with two real people on the check project. A teammate's press of Refund
// waits, once, with the row named; their hand edit to Refunded is refused
// and names the button, while another edit goes through; they cannot
// decide. The owner sees it waiting and approves: the row is refunded,
// worked out from the row as it is then. The owner's own press is done at
// once. A row that moved on before the yes is told so and left alone; a
// press declined changes nothing.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node scripts/check-row-approval-live.mjs
//
// Never with CI running: one check database.

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
const APP = process.env.APP_URL ?? "http://localhost:3100";

const rest =
  (jwt, key = ANON) =>
  async (path, init = {}) => {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...init.headers,
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, json: body ? JSON.parse(body) : null };
  };
const app = (jwt) => async (path, body) => {
  const res = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
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
const owner = await signup(`appr-owner-${stamp}@warmluke.test`);
const staff = await signup(`appr-staff-${stamp}@warmluke.test`);
const O = rest(owner.jwt);
const S = rest(staff.jwt);
const ADMIN = rest(SVC, SVC);
const OA = app(owner.jwt);
const SA = app(staff.jwt);
let projectId = null;

try {
  const [proj] = (
    await O("projects", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: "Approvals" }) })
  ).json;
  projectId = proj.id;
  const [mod] = (
    await O("modules", {
      method: "POST",
      body: JSON.stringify({
        project_id: proj.id,
        name: `returns_${stamp}`,
        nav_label: "Returns",
        route: `/returns_${stamp}`,
        shared_with_team: true,
      }),
    })
  ).json;
  const is = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });
  await ADMIN("ui_schemas", {
    method: "POST",
    body: JSON.stringify({
      module_id: mod.id,
      version: 1,
      created_by: "ai",
      schema_json: {
        columns: [
          { field: "customer", label: "Customer", type: "text" },
          { field: "status", label: "Status", type: "badge" },
          { field: "amount", label: "Amount", type: "currency" },
          { field: "refund", label: "Refund", type: "currency" },
        ],
        features: {
          actions: [
            {
              label: "Refund",
              approval: true,
              set: { status: { const: "Refunded" }, refund: { field: "amount" } },
              when: is("status", "Received"),
            },
          ],
        },
      },
    }),
  });
  const [seat] = (await O("project_members", { method: "POST", body: JSON.stringify({ project_id: proj.id }) })).json;
  await S("rpc/abo_join", { method: "POST", body: JSON.stringify({ p_token: seat.token }) });
  const row = async (customer) =>
    (
      await O("records", {
        method: "POST",
        body: JSON.stringify({
          project_id: proj.id,
          module_id: mod.id,
          data: { customer, status: "Received", amount: 900 },
        }),
      })
    ).json[0];
  const [asha, ravi, meera, kabir] = [await row("Asha"), await row("Ravi"), await row("Meera"), await row("Kabir")];
  const data = async (r) => (await ADMIN(`records?id=eq.${r.id}&select=data`)).json[0].data;
  const press = (who, r) =>
    who("/api/row-action", { projectId: proj.id, moduleId: mod.id, recordId: r.id, label: "Refund" });

  console.log("a teammate presses Refund");
  const first = await press(SA, asha);
  check("it waits for the owner", first.status === 200 && first.json.waiting === true && !!first.json.approvalId);
  check("and the row is as it was", (await data(asha)).status === "Received");
  const again = await press(SA, asha);
  check("pressed again, the same wait", again.json.approvalId === first.json.approvalId);
  const hand = await SA("/api/records", {
    action: "update",
    projectId: proj.id,
    moduleId: mod.id,
    recordId: asha.id,
    data: { status: "Refunded" },
  });
  check("by hand, refused, naming the button", hand.status === 409 && hand.json.approval === "Refund");
  const other = await SA("/api/records", {
    action: "update",
    projectId: proj.id,
    moduleId: mod.id,
    recordId: asha.id,
    data: { customer: "Asha K" },
  });
  check("another edit goes through", other.status === 200);
  const theirWord = await SA("/api/row-action", {
    projectId: proj.id,
    approvalId: first.json.approvalId,
    decision: "approve",
  });
  check("and they cannot decide", theirWord.status === 403);

  console.log("\nthe owner");
  const { json: waiting } = await O(
    `row_approvals?project_id=eq.${proj.id}&status=eq.waiting&select=id,action,row_label`
  );
  check("sees it waiting, the row named", waiting?.length === 1 && /Asha/.test(waiting[0].row_label));
  const yes = await OA("/api/row-action", {
    projectId: proj.id,
    approvalId: first.json.approvalId,
    decision: "approve",
  });
  const now = await data(asha);
  check(
    "approves: the row is refunded, worked out from it",
    yes.json.done === true && now.status === "Refunded" && now.refund === 900
  );
  const { json: decided } = await ADMIN(`row_approvals?id=eq.${first.json.approvalId}&select=status,decided_by`);
  check("and it is theirs, once", decided[0].status === "approved" && decided[0].decided_by === owner.id);
  const twice = await OA("/api/row-action", {
    projectId: proj.id,
    approvalId: first.json.approvalId,
    decision: "approve",
  });
  check("approved again: already decided", twice.status === 409);
  const own = await press(OA, ravi);
  check("their own press is done at once", own.json.done === true && (await data(ravi)).status === "Refunded");

  console.log("\na row that moved on, and a no");
  const stale = await press(SA, meera);
  await OA("/api/records", {
    action: "update",
    projectId: proj.id,
    moduleId: mod.id,
    recordId: meera.id,
    data: { status: "Requested" },
  });
  const late = await OA("/api/row-action", {
    projectId: proj.id,
    approvalId: stale.json.approvalId,
    decision: "approve",
  });
  check("moved on: told so, and left alone", late.json.stale === true && (await data(meera)).status === "Requested");
  const no = await press(SA, kabir);
  const declined = await OA("/api/row-action", {
    projectId: proj.id,
    approvalId: no.json.approvalId,
    decision: "decline",
  });
  check("declined: nothing changes", declined.json.declined === true && (await data(kabir)).status === "Received");
} finally {
  if (projectId) await ADMIN(`projects?id=eq.${projectId}`, { method: "DELETE" });
  for (const u of [owner, staff])
    await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
}

console.log(
  fails.length === 0
    ? "\na button that waits for the owner waits, and the owner's yes does it"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
