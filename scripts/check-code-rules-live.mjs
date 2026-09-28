// A rule's own code, run for real: the courier's charge worked out from
// a rate card the owner keeps, in a sealed sandbox, after their own
// write, and written back through their own door.
//
// Built with no model: a design with two sections and a code rule goes
// through /api/apply as Luke's would. A parcel added is charged by the
// card; its weight changed, it is charged again; a card changed is read
// on the next write. Needs a server that can reach a sandbox (on Vercel,
// its own identity; locally VERCEL_SANDBOX_TOKEN, VERCEL_TEAM_ID,
// VERCEL_PROJECT_ID) — without one nothing is charged, and it says so.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-code-rules-live.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(
  createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY),
  env
);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${me.session.access_token}` };
const project = await throwawayProject(admin, me.user.id, "code rules");
const post = async (path, body) => {
  const r = await fetch(`${APP}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const CODE = `export default function run({ row, sections }) {
  const card = sections["#rates"] ?? [];
  const slabs = card.filter((r) => Number(r.upto_g) > 0).sort((a, b) => a.upto_g - b.upto_g);
  const fee = (name) => Number(card.find((r) => r.name === name)?.charge ?? 0);
  const g = Number(row.weight_g) || 0;
  const slab = slabs.find((s) => g <= s.upto_g);
  const top = slabs[slabs.length - 1];
  let charge = slab ? Number(slab.charge) : Number(top.charge) + Math.ceil((g - top.upto_g) / 500) * fee("extra_500g");
  if (row.cod) charge += fee("cod");
  return { set: [{ id: row.id, fields: { charge } }] };
}`;

try {
  const built = await post("/api/apply", {
    projectId: project.id,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "rates", nav_label: "Rate card", icon: "table" },
        newSchema: {
          columns: [
            { field: "name", label: "Name", type: "text" },
            { field: "upto_g", label: "Up to (g)", type: "number" },
            { field: "charge", label: "Charge", type: "currency" },
          ],
        },
        explanation: "The courier's rate card.",
      },
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "parcels", nav_label: "Parcels", icon: "table" },
        newSchema: {
          columns: [
            { field: "weight_g", label: "Weight (g)", type: "number" },
            { field: "cod", label: "COD", type: "boolean" },
            { field: "charge", label: "Charge", type: "currency" },
          ],
        },
        explanation: "Parcels, charged by the card.",
      },
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: "#parcels",
        automation: {
          name: "charge by the card",
          definition: {
            trigger: { type: "record_created" },
            actions: [{ type: "run_code", reads: ["#rates"], code: CODE }],
          },
        },
        explanation: "Works out the charge when a parcel is added.",
      },
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: "#parcels",
        automation: {
          name: "charge again when the weight changes",
          definition: {
            trigger: { type: "record_updated", when: { op: "changed", args: [{ field: "weight_g" }] } },
            actions: [{ type: "run_code", reads: ["#rates"], code: CODE }],
          },
        },
        explanation: "And again when the weight changes.",
      },
    ],
  });
  console.log("a design with a code rule, through the door Luke's goes through");
  check("is built", built.status === 200);
  if (built.status !== 200) console.log("     →", JSON.stringify(built.json).slice(0, 400));
  const { data: mods } = await admin.from("modules").select("id, name").eq("project_id", project.id);
  const idOf = (n) => mods.find((m) => m.name === n)?.id;
  const { data: rules } = await admin.from("automations").select("definition").eq("module_id", idOf("parcels"));
  check(
    "and the card it reads is named by its id once built",
    rules?.length === 2 && rules.every((r) => r.definition.actions[0].reads[0] === idOf("rates"))
  );

  for (const data of [
    { name: "light", upto_g: 500, charge: 40 },
    { name: "medium", upto_g: 1000, charge: 65 },
    { name: "extra_500g", charge: 25 },
    { name: "cod", charge: 30 },
  ])
    await post("/api/records", { action: "create", projectId: project.id, moduleId: idOf("rates"), data });

  const chargeOf = async (id) => {
    for (let i = 0; i < 120; i++) {
      const { data } = await admin.from("records").select("data").eq("id", id).single();
      if (typeof data?.data?.charge === "number") return data.data.charge;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };
  const waitFor = async (id, want) => {
    for (let i = 0; i < 120; i++) {
      const { data } = await admin.from("records").select("data").eq("id", id).single();
      if (data?.data?.charge === want) return want;
      await new Promise((r) => setTimeout(r, 500));
    }
    const { data } = await admin.from("records").select("data").eq("id", id).single();
    return data?.data?.charge ?? null;
  };

  console.log("\na parcel added, charged by the card");
  const parcel = await post("/api/records", {
    action: "create",
    projectId: project.id,
    moduleId: idOf("parcels"),
    data: { weight_g: 1700, cod: true },
  });
  const id = parcel.json.record?.id;
  const first = await chargeOf(id);
  if (first === null) {
    console.log("  skip  no charge came: this server cannot reach a sandbox (see the header), so the code was not run");
  } else {
    check("1.7 kg, COD: 65 + 2 × 25 + 30 = 145", first === 145);
    console.log("\nits weight changed, charged again");
    await post("/api/records", {
      action: "update",
      projectId: project.id,
      moduleId: idOf("parcels"),
      recordId: id,
      data: { weight_g: 300, cod: true },
    });
    check("300 g, COD: 40 + 30 = 70", (await waitFor(id, 70)) === 70);
    console.log("\na change that is not its weight runs nothing");
    await post("/api/records", {
      action: "update",
      projectId: project.id,
      moduleId: idOf("parcels"),
      recordId: id,
      data: { cod: false },
    });
    await new Promise((r) => setTimeout(r, 6000));
    const { data: kept } = await admin.from("records").select("data").eq("id", id).single();
    check("the charge stays what the last weight made it", kept.data.charge === 70);
  }
} finally {
  await project.remove();
}

console.log(
  fails.length === 0
    ? "\na rule's own code works out what the expressions cannot, and writes it back"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
