// A rule is handed every row of what it reads, and every run is kept
// (lib/code-rules readSections, runCodeRules; 0206).
//
// Tanish's Parent Stock sync read the first 500 of 2,058 stock rows, so
// the 34 it was for were never among them, and it said so to nobody (11
// Oct). Here a store list and a section of the owner's own, each past the
// thousand rows the database hands back at once, are read whole, the
// owner's own fields beside the store's rows; and a rule run after the
// owner's write is kept with what it read, even where its code cannot run
// (no sandbox here: nothing is paid), and read back as the owner.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-rule-reads-live.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { readSections, runCodeRules } from "../src/lib/code-rules.ts";
import { readRuleRuns } from "../src/lib/rule-runs.ts";

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

const stamp = Date.now();
const email = `rule_reads_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
await owner.auth.signInWithPassword({ email, password });
const ownerId = made.user.id;
let projectId = null;
try {
  const { data: project } = await admin
    .from("projects")
    .insert({ owner_id: ownerId, name: `rule-reads ${stamp}` })
    .select("id")
    .single();
  projectId = project.id;
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: projectId, shop_domain: `rule-reads-${stamp}.myshopify.com`, status: "connected" })
    .select("id")
    .single();
  const ORDERS = 1150;
  const orders = Array.from({ length: ORDERS }, (_, i) => ({
    store_id: store.id,
    external_id: `gid://shopify/Order/${stamp}${i}`,
    order_number: `#${10000 + i}`,
    source: "shopify",
  }));
  const ids = [];
  for (let i = 0; i < orders.length; i += 500) {
    const { data, error } = await admin
      .from("orders")
      .insert(orders.slice(i, i + 500))
      .select("id");
    if (error) throw new Error(error.message);
    ids.push(...data.map((r) => r.id));
  }
  const section = (name, source_table = null) => ({
    project_id: projectId,
    name: `${name}-${stamp}`,
    nav_label: name,
    route: `/modules/${name.toLowerCase()}-${stamp}`,
    created_by: ownerId,
    source_table,
  });
  const { data: mods } = await admin
    .from("modules")
    .insert([section("Orders here", "orders"), section("Notes")])
    .select("id, nav_label");
  const ordersMod = mods.find((m) => m.nav_label === "Orders here").id;
  const notesMod = mods.find((m) => m.nav_label === "Notes").id;
  // The owner's own field on three store rows, the last of them past the first thousand.
  const tagged = [ids[0], ids[600], ids[ORDERS - 1]];
  await admin.from("records").insert(
    tagged.map((rowId) => ({
      module_id: ordersMod,
      project_id: projectId,
      store_row_id: rowId,
      data: { parent_sku: "POX-SL" },
      created_by: ownerId,
    }))
  );
  const NOTES = 1050;
  for (let i = 0; i < NOTES; i += 500) {
    const { error } = await admin.from("records").insert(
      Array.from({ length: Math.min(500, NOTES - i) }, (_, k) => ({
        module_id: notesMod,
        project_id: projectId,
        data: { note: `n${i + k}` },
        created_by: ownerId,
      }))
    );
    if (error) throw new Error(error.message);
  }

  console.log("\nevery row of what a rule reads");
  const read = await readSections(owner, projectId, [ordersMod, notesMod]);
  const orderRows = read.rows[`#Orders here-${stamp}`] ?? [];
  check(`a store list past a thousand rows, whole (${orderRows.length} of ${ORDERS})`, orderRows.length === ORDERS);
  check(
    "each row once",
    new Set(orderRows.map((r) => r.id)).size === ORDERS && orderRows.every((r) => typeof r.id === "string")
  );
  const withSku = orderRows.filter((r) => r.parent_sku === "POX-SL").map((r) => r.id);
  check(
    "with the owner's own field beside every row it is on, the last one too",
    withSku.length === 3 && tagged.every((t) => withSku.includes(t))
  );
  check(`a section of their own past a thousand, whole`, (read.rows[`#Notes-${stamp}`] ?? []).length === NOTES);
  check(
    "and what each read came to, by name",
    read.sizes["Orders here"]?.rows === ORDERS &&
      read.sizes["Orders here"]?.cut === false &&
      read.sizes.Notes?.rows === NOTES
  );

  console.log("\nevery run is kept");
  const { data: rule } = await admin
    .from("automations")
    .insert({
      project_id: projectId,
      module_id: notesMod,
      name: "Push to children",
      definition: {
        trigger: { type: "record_updated" },
        actions: [
          {
            type: "run_code",
            reads: [ordersMod],
            code: "export default function run({ row, sections }) { return { set: [] }; }",
          },
        ],
      },
    })
    .select("id")
    .single();
  const { data: note } = await admin.from("records").select("id, data").eq("module_id", notesMod).limit(1).single();
  await runCodeRules(owner, {
    event: "updated",
    projectId,
    moduleId: notesMod,
    record: note,
    previous: { note: "before" },
    table: null,
    storeRowId: null,
    columns: [],
  });
  const runs = await readRuleRuns(owner, projectId, { rule: "push to children" });
  check("a rule run after the owner's write leaves a run", runs.length === 1);
  check(
    "with what it read of each section, whole",
    runs[0]?.read?.["Orders here"]?.rows === ORDERS && runs[0]?.read?.["Orders here"]?.cut === false
  );
  check(
    "and why it did nothing, where its code could not run",
    runs[0]?.ok === false &&
      /cannot run here|sandbox/i.test(runs[0]?.error ?? "") &&
      runs[0]?.trigger === "a row changed"
  );
  const { data: log } = await owner.rpc("abo_rule_log", { p_project: projectId });
  check("and the Rules dialog counts it", log?.[rule.id]?.runs === 1 && log?.[rule.id]?.failed === 1);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(ownerId);
}

console.log(failed ? `\n${failed} failed` : "\na rule reads all it asks for, and says what it did");
process.exit(failed ? 1 : 0);
