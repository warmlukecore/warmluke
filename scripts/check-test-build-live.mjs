// What was just built, tried on the real rows before anyone is told it
// is done (lib/verify.ts testBuild, Luke's and MCP's test_build).
//
// Tanish's shape, made general: a section of blanks, and 1,200 designs (past
// the thousand rows the database hands back at once), 34 of them cut from
// one blank. A rule set off by a change reaches them; a rule of code is run
// through the runtime's own reader, on every design, its own code run here
// as the sandbox would run it (no sandbox locally: nothing is paid); a rule
// writing a field that is not there is a problem, with its evidence; what
// it was meant to do comes back beside it; a stranger sees nothing.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-test-build-live.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { readSections, storeZone } from "../src/lib/code-rules.ts";
import { parseResult } from "../src/lib/code-run.ts";
import { testBuild } from "../src/lib/verify.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") throw new Error("Not the check project's env; this writes.");
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

/** The sandbox, stood in for: the rule's own code, run here and read back as a run's answer is. */
const here = {
  can: () => true,
  read: readSections,
  zone: storeZone,
  run: async (code, inputs) => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
    // A section however the code spells it, as the sandbox's runner hands it (lib/code-run RUNNER).
    const key = (s) =>
      String(s)
        .trim()
        .replace(/^#/, "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "-");
    return inputs.map(({ __names: aliases, ...input }) => {
      const sections = new Proxy(input.sections, {
        get: (t, p) => (typeof p !== "string" || p in t ? t[p] : t[aliases[key(p)]]),
      });
      try {
        const result = parseResult(mod.default({ ...input, sections }));
        return result ? { ok: true, result } : { ok: false, error: "It handed back nothing a run can use." };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  },
};

const stamp = Date.now();
async function person(tag) {
  const email = `test_build_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, client };
}
const owner = await person("owner");
const stranger = await person("stranger");
let projectId = null;
try {
  const { data: project } = await admin
    .from("projects")
    .insert({ owner_id: owner.id, name: `test-build ${stamp}` })
    .select("id")
    .single();
  projectId = project.id;
  const section = (name) => ({
    project_id: projectId,
    name: `${name.toLowerCase()}-${stamp}`,
    nav_label: name,
    route: `/modules/${name.toLowerCase()}-${stamp}`,
    created_by: owner.id,
  });
  const { data: mods } = await admin
    .from("modules")
    .insert([section("Blanks"), section("Designs")])
    .select("id, nav_label");
  const blanks = mods.find((m) => m.nav_label === "Blanks").id;
  const designs = mods.find((m) => m.nav_label === "Designs").id;
  const { error: schemaError } = await admin.from("ui_schemas").insert([
    {
      module_id: blanks,
      version: 1,
      created_by: "user",
      schema_json: {
        columns: [
          { field: "parent_sku", label: "Parent SKU", type: "text" },
          { field: "total_available", label: "Total available", type: "number" },
        ],
      },
    },
    {
      module_id: designs,
      version: 1,
      created_by: "user",
      schema_json: {
        columns: [
          { field: "design", label: "Design", type: "text" },
          { field: "parent_sku", label: "Parent SKU", type: "text" },
          { field: "blank_left", label: "Blank left", type: "number" },
        ],
      },
    },
  ]);
  if (schemaError) throw new Error(`ui_schemas: ${schemaError.message}`);
  await admin.from("records").insert({
    module_id: blanks,
    project_id: projectId,
    data: { parent_sku: "POX-SL", total_available: 500 },
    created_by: owner.id,
  });
  const DESIGNS = 1200;
  for (let i = 0; i < DESIGNS; i += 500) {
    const { error } = await admin.from("records").insert(
      Array.from({ length: Math.min(500, DESIGNS - i) }, (_, k) => {
        const n = i + k;
        // The 34 cut from POX-SL are the oldest: the last a newest-first read of a thousand reaches.
        return {
          module_id: designs,
          project_id: projectId,
          data: { design: `Design ${n}`, parent_sku: n < 34 ? "POX-SL" : `OTHER-${n}` },
          created_by: owner.id,
        };
      })
    );
    if (error) throw new Error(error.message);
  }
  const PUSH = `export default function run({ row, sections }) {
  const set = [];
  for (const d of sections.designs || []) if (d.parent_sku === row.parent_sku) set.push({ id: d.id, section: "designs", fields: { blank_left: row.total_available } });
  return { set };
}`;
  const rules = [
    {
      name: "Push blank to designs",
      definition: {
        trigger: { type: "record_updated", when: { op: "changed", args: [{ field: "total_available" }] } },
        actions: [
          {
            type: "set_fields",
            target: { module_id: designs, match: { field: "parent_sku", to: { field: "parent_sku" } } },
            set: { blank_left: { field: "total_available" } },
          },
        ],
      },
    },
    {
      name: "Push by code",
      definition: {
        trigger: { type: "record_created" },
        actions: [{ type: "run_code", code: PUSH, reads: [designs] }],
      },
    },
    {
      name: "Broken push",
      definition: {
        trigger: { type: "record_created" },
        actions: [{ type: "run_code", code: PUSH.replace("blank_left", "blank_remaining"), reads: [designs] }],
      },
    },
  ];
  const { error: ruleError } = await admin.from("automations").insert(
    rules.map((r) => ({
      project_id: projectId,
      module_id: blanks,
      name: r.name,
      enabled: true,
      definition: r.definition,
    }))
  );
  if (ruleError) throw new Error(ruleError.message);

  console.log("\nwhat was built, tried on the real rows");
  const expect = "sets Blank left on the 34 designs cut from POX-SL";
  const got = await testBuild(owner.client, projectId, { rules: rules.map((r) => r.name) }, expect, here);
  const of = (name) => got.rules.find((r) => r.rule === name);
  if (process.env.SHOW) console.log(JSON.stringify(got, null, 1));
  const change = of("Push blank to designs");
  check(
    "a rule set off by a change reaches the 34, as if the count had just changed",
    (change?.result ?? "").startsWith("34 of 1200 Designs rows") &&
      /As if each row's Total available had just changed/.test(change.result)
  );
  const code = of("Push by code");
  check(
    "a rule of code, through the runtime's reader, reaches all 34 past the thousandth row",
    /would set Blank left on 34 Designs rows/.test(code?.result ?? "") && !code.problem
  );
  const broken = of("Broken push");
  check("one writing a field that is not there is a problem", /no such field/.test(broken?.problem ?? ""));
  check(
    "so the build is not ok, and the line says why first",
    got.ok === false && /stops? it working/.test(got.said) && /Broken push/.test(got.said)
  );
  check("what it was meant to do comes back beside it", got.expected === expect);
  check("it says what it tried", got.tested.rules === 3 && got.tested.sections === 1);

  console.log("\nwhat was built lately, when nothing is named");
  const lately = await testBuild(owner.client, projectId, {}, undefined, here);
  check("the rules and sections made in the last hour", lately.tested.rules === 3 && lately.tested.sections === 2);

  console.log("\na name that is nothing");
  const none = await testBuild(owner.client, projectId, { rules: ["No such rule"] }, undefined, here);
  check(
    "says so, and claims nothing",
    none.ok && /Nothing called "No such rule"/.test(none.notes.join(" ")) && none.tested.rules === 0
  );

  console.log("\nwhose it is");
  const theirs = await testBuild(stranger.client, projectId, { rules: rules.map((r) => r.name) }, undefined, here);
  check("a stranger is shown nothing of it", theirs.tested.rules === 0 && theirs.rules.length === 0);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

console.log(failed ? `\n${failed} failed` : "\nwhat was built is tried on their rows before it is called done");
process.exit(failed ? 1 : 0);
