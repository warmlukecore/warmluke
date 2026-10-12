// Luke reads the rows the merchant made, as their own AI does (12 Oct).
//
// Asked to check the row Tanish had just added to Parent Stock, Luke said
// he could not see it (Carefone, 11 Oct): his tools reached only the
// store's lists, while their own Claude could read it through
// read_section. One reader now (lib/section-read), for both. Holds: a row
// is found by a word or by a field's value wherever it sits in the
// section, with how many match; a field worked out on reading is refused
// with why, not answered wrong; a stranger reads nothing (RLS); and what
// the rules did is his to read too.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-section-read.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { appTools } from "../src/lib/section-read.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

const stamp = Date.now();
async function person(tag) {
  const email = `section_read_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in ${tag}: ${signIn.message}`);
  return { id: data.user.id, client };
}

const owner = await person("owner");
const stranger = await person("stranger");
let projectId = null;
try {
  const { data: project, error: pe } = await admin
    .from("projects")
    .insert({ owner_id: owner.id, name: `section-read ${stamp}` })
    .select("id")
    .single();
  if (pe) throw new Error(`could not make the project: ${pe.message}`);
  projectId = project.id;
  const { data: mod, error: me } = await admin
    .from("modules")
    .insert({
      project_id: projectId,
      name: "parent-stock",
      nav_label: "Parent Stock",
      icon: "box",
      route: "/modules/parent-stock",
    })
    .select("id")
    .single();
  if (me) throw new Error(`could not make the section: ${me.message}`);
  await admin.from("ui_schemas").insert({
    module_id: mod.id,
    version: 1,
    created_by: "ai",
    schema_json: {
      columns: [
        { field: "parent_sku", label: "Parent SKU", type: "text" },
        { field: "total_available", label: "Total available", type: "number" },
        {
          field: "status",
          label: "Status",
          type: "badge",
          compute: {
            op: "if",
            args: [
              { op: "<", args: [{ field: "total_available" }, { const: 100 }] },
              { const: "Low" },
              { const: "OK" },
            ],
          },
        },
      ],
    },
  });
  // Many rows, the one asked about among the oldest: a page of the newest would never reach it.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    project_id: projectId,
    module_id: mod.id,
    data: { parent_sku: i === 0 ? "POX-iPh17PM-SL" : `POX-${i}`, total_available: i === 0 ? 500 : i },
  }));
  for (const r of rows) await admin.from("records").insert(r);

  const tools = appTools({ db: owner.client, projectId });
  const run = (name, args) => tools[name].execute(args, { toolCallId: "t", messages: [] });

  console.log("\nhis own sections, listed");
  const listed = await run("read_section", {});
  check(
    "with where their rows come from",
    listed.sections?.some((s) => s.section === "Parent Stock" && s.rows_from === "this app")
  );

  console.log("\na row they made, found wherever it sits");
  const byWord = await run("read_section", { section: "parent stock", search: "iPh17PM" });
  check("by a word in a text field", byWord.total === 1 && byWord.rows?.[0]?.parent_sku === "POX-iPh17PM-SL");
  const byField = await run("read_section", { section: "Parent Stock", field: "parent_sku", value: "POX-iPh17PM-SL" });
  check("by a field's exact value", byField.total === 1 && byField.rows?.[0]?.total_available === 500);
  check(
    "with the section's fields beside",
    byField.fields?.some((f) => f.field === "status")
  );
  const newest = await run("read_section", { section: "Parent Stock", limit: 5 });
  check("and how many there are beside the ones shown", newest.total === 60 && newest.showing === 5);
  const worked = await run("read_section", { section: "Parent Stock", field: "status", value: "Low" });
  check("a field worked out on reading is refused, with why", /worked out/.test(worked.error ?? ""));
  const none = await run("read_section", { section: "Nowhere" });
  check(
    "a section that is not there names the ones that are",
    /No section/.test(none.error ?? "") && none.sections?.includes("Parent Stock")
  );

  console.log("\nwho may");
  const theirs = appTools({ db: stranger.client, projectId });
  const blind = await theirs.read_section.execute({ section: "Parent Stock" }, { toolCallId: "t", messages: [] });
  check("a stranger reads nothing of it", (blind.sections ?? []).length === 0 || /No section/.test(blind.error ?? ""));

  console.log("\nwhat the rules did");
  const runs = await run("rule_runs", {});
  check(
    "is his to read, and says so when there is none",
    Array.isArray(runs.runs) && (runs.runs.length > 0 || !!runs.note)
  );
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

console.log(failed ? `\n${failed} failed` : "\nLuke reads what the merchant made");
process.exit(failed ? 1 : 0);
