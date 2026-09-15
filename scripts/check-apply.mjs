// Every write the builder makes, driven the way the app drives it.
//
// The apply path now writes through abo_build rather than touching
// tables, so a mistake in that move would not fail any other check
// here — it would fail silently, in the browser, the first time
// somebody approved a design. Each change type is applied for real and
// read back, then removed.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-apply.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
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

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const { data: owner } = await client.auth.signInWithPassword({
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("no OWNER_PASSWORD given — nothing to check");
  process.exit(0);
}
const token = owner.session.access_token;
const db = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY,
  { global: { headers: { Authorization: `Bearer ${token}` } } }
);

const { data: projects } = await db.from("projects").select("id").limit(1);
const projectId = projects?.[0]?.id;
if (!projectId) {
  console.log("no project on this account — nothing to check");
  process.exit(0);
}

const apply = (plans) =>
  fetch(`${APP}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, plans }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const stamp = Date.now().toString(36);
const NAME = `apply-check-${stamp}`;
const plan = (over) => ({
  changeType: "UI_CHANGE",
  targetModuleId: null,
  newModule: null,
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "checking the write path",
  ...over,
});
const col = (field, label, type) => ({ field, label, type });

let moduleId = null;
try {
  console.log("a new section, with its columns and a row in it");
  const made = await apply([
    plan({
      changeType: "NEW_MODULE",
      newModule: { name: NAME, nav_label: `Apply Check ${stamp}`, icon: "table" },
      newSchema: { columns: [col("order_no", "Order", "text"), col("done", "Done", "boolean")] },
      newRecords: [{ order_no: "1001", done: false }],
    }),
  ]);
  check("the section is built", made.json?.applied === true);
  moduleId = made.json?.results?.[0]?.moduleId ?? null;
  check("and it names what it made", !!moduleId);

  const { data: schema } = await db
    .from("ui_schemas")
    .select("schema_json, version")
    .eq("module_id", moduleId)
    .order("version", { ascending: false })
    .limit(1);
  check("its columns went in", schema?.[0]?.schema_json?.columns?.length === 2);

  const { count: seeded } = await db
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("module_id", moduleId);
  check("and so did the row it was seeded with", seeded === 1);

  console.log("\nchanging it");
  const added = await apply([
    plan({
      changeType: "FIELD_ADD",
      targetModuleId: moduleId,
      newSchema: {
        columns: [
          col("order_no", "Order", "text"),
          col("done", "Done", "boolean"),
          col("packer", "Packed by", "text"),
        ],
      },
    }),
  ]);
  check("a new field is a new version, not an overwrite", added.json?.results?.[0]?.version === 2);

  const renamed = await apply([
    plan({
      changeType: "MODULE_UPDATE",
      targetModuleId: moduleId,
      moduleUpdate: { nav_label: `Renamed ${stamp}` },
    }),
  ]);
  check("the section can be renamed", renamed.json?.applied === true);
  const { data: mod } = await db.from("modules").select("nav_label").eq("id", moduleId).single();
  check("and the new name is really there", mod?.nav_label === `Renamed ${stamp}`);

  const seeded2 = await apply([
    plan({ changeType: "RECORD_SEED", targetModuleId: moduleId, newRecords: [{ order_no: "1002" }] }),
  ]);
  check("more rows can be seeded", seeded2.json?.results?.[0]?.seeded === 1);

  console.log("\nrules");
  const rule = await apply([
    plan({
      changeType: "AUTOMATION_ADD",
      targetModuleId: moduleId,
      automation: {
        name: `mark-${stamp}`,
        definition: {
          trigger: { type: "record_created" },
          actions: [{ type: "set_fields", target: { self: true }, set: { done: { const: true } } }],
        },
      },
    }),
  ]);
  check("a rule is stored as data", !!rule.json?.results?.[0]?.automationId);

  const off = await apply([
    plan({
      changeType: "AUTOMATION_REMOVE",
      targetModuleId: moduleId,
      automationRemoveName: `mark-${stamp}`,
    }),
  ]);
  check("and can be switched off", off.json?.results?.[0]?.disabled === 1);
  const { data: auto } = await db
    .from("automations")
    .select("enabled")
    .eq("project_id", projectId)
    .eq("name", `mark-${stamp}`)
    .single();
  check("switched off, not deleted — the run log stays readable", auto?.enabled === false);

  const missing = await apply([
    plan({
      changeType: "AUTOMATION_REMOVE",
      targetModuleId: moduleId,
      automationRemoveName: `no-such-rule-${stamp}`,
    }),
  ]);
  check("removing a rule that never existed is refused", missing.status === 422);

  console.log("\nand what the path must not do");
  const nonsense = await apply([plan({ changeType: "SOMETHING_ELSE", targetModuleId: moduleId })]);
  check("an unknown change type builds nothing", nonsense.status === 422);

  const stranger = await fetch(`${APP}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: "00000000-0000-0000-0000-000000000000",
      plans: [plan({ changeType: "NEW_MODULE", newModule: { name: "x", nav_label: "X", icon: "table" }, newSchema: { columns: [col("a", "A", "text")] } })],
    }),
  });
  check("a project that is not theirs is not found", stranger.status === 404);
} finally {
  if (moduleId) {
    const gone = await apply([
      plan({ changeType: "MODULE_DELETE", targetModuleId: moduleId, deleteConfirmName: NAME }),
    ]);
    check("the section can be deleted again", gone.json?.applied === true);
    const { data: left } = await db.from("modules").select("id").eq("id", moduleId);
    check("and it is gone", (left ?? []).length === 0);
  }
  await db.from("automations").delete().eq("project_id", projectId).eq("name", `mark-${stamp}`);
}

// ── And what the owner is told afterwards ───────────────────────
// The receipt used to read "Built 1 changes": a number, and the number
// is the least interesting part of it. The panel now writes the same
// line the approval card showed, so the two cannot drift apart.
console.log("\nthe receipt names what changed");
{
  const { describePlan } = await import("../src/lib/describe.ts");
  const mods = [{ id: "m1", nav_label: "Products" }];
  const titled = (p, cols) => describePlan(p, mods, cols).title;

  const added = titled(
    plan({ changeType: "FIELD_ADD", targetModuleId: "m1", newSchema: { columns: [col("cat", "Category", "text")] } })
  );
  check("a new field names the section", added === "Add fields to Products");

  // The commonest edit of all, and the one that used to come back as
  // "Applied as schema v4".
  const moved = titled(
    plan({ changeType: "UI_CHANGE", targetModuleId: "m1", newSchema: { columns: [col("a", "A", "text"), col("b", "B", "text")] } }),
    [{ field: "a", label: "A" }]
  );
  check("a column added under UI_CHANGE still says so", moved === "Add fields to Products");

  const made = titled(
    plan({ changeType: "NEW_MODULE", newModule: { name: "sup", nav_label: "Suppliers", icon: "table" }, newSchema: { columns: [col("a", "A", "text")] } })
  );
  check("a new section is named", made === "New section: Suppliers");

  // Nothing here may come back empty or with an "undefined" in it: the
  // receipt is the whole sentence the owner reads.
  for (const t of [added, moved, made]) {
    if (!t || /undefined|null/.test(t)) check(`a usable line, not "${t}"`, false);
  }
  check("none of them are gaps", !fails.some((f) => f.startsWith("a usable line")));
}

console.log(fails.length === 0 ? "\nevery write lands" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
