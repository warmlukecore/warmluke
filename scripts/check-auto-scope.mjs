// What "build without asking me first" actually covers.
//
// The setting used to build additions and hold back everything else,
// five a day. So a merchant turned it on, asked for a change to a
// section they already had, and got a Build it button — which is not
// what the word on the switch says. It now means everything.
//
// This drives submit_design rather than propose_change: both doors end
// at the same settleDesign, so the decision under test is identical,
// and this one runs no model at all. That makes the changeTypes exact
// instead of whatever a sentence happened to produce, and it keeps
// working when the model key will not.
//
//   node scripts/check-auto-scope.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsOwner } from "./owner-session.mjs";

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
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const owner = await signInAsOwner(client, env);
if (!owner.session) {
  console.log(`could not sign in as the owner — ${owner.why}`);
  process.exit(1);
}
const token = owner.session.access_token;
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin
  .from("projects")
  .select("id, auto_build")
  .eq("owner_id", owner.user.id)
  .limit(1)
  .single();

let n = 0;
const tool = async (name, args) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++n,
      method: "tools/call",
      params: { name, arguments: { project_id: project.id, ...args } },
    }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return { error: `unreadable answer: ${JSON.stringify(j).slice(0, 200)}` };
  }
};

const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);
const stamp = Date.now().toString(36);
const slug = `scope-${stamp}`;

/** Every row this run makes, so the finally can take exactly those out. */
const madeRequests = [];
let moduleId = null;
let aiThreadId = null;

const submit = async (request, plans) => {
  const r = await tool("submit_design", { request, plans });
  if (r?.request_id) madeRequests.push(r.request_id);
  return r;
};
const isBuilt = (r) => r?.status === "built" || r?.status === "partly built";

try {
  console.log("with the setting off, everything waits");
  await setAuto(false);
  const off = await submit(`Scope check ${stamp} — off`, [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: `${slug}-off`, nav_label: `Scope ${stamp} off`, icon: "table" },
      newSchema: { columns: [{ field: "note", label: "Note", type: "text" }], view: { type: "table" } },
      explanation: "Somewhere to write a note.",
    },
  ]);
  check("even an addition waits", off?.status === "waiting for approval");
  if (off?.status !== "waiting for approval") show(off);

  console.log("\nwith it on: an addition, as before");
  await setAuto(true);
  const added = await submit(`Scope check ${stamp} — new section`, [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: slug, nav_label: `Scope ${stamp}`, icon: "table" },
      newSchema: {
        columns: [
          { field: "note", label: "Note", type: "text" },
          { field: "stage", label: "Stage", type: "text" },
        ],
        view: { type: "table" },
      },
      explanation: "Somewhere to write a note.",
    },
  ]);
  check("it is built there and then", isBuilt(added));
  if (!isBuilt(added)) show(added);
  moduleId = (added?.built ?? []).map((b) => b.moduleId).find(Boolean) ?? null;
  check("and the section is really there", !!moduleId);

  // The one the merchant asked about. A section they already have,
  // changed rather than added to — this is exactly what used to come
  // back as a Build it button with the switch on.
  console.log("\nand a change to a section that already exists");
  const changed = await submit(`Scope check ${stamp} — dashboard`, [
    {
      changeType: "FEATURE_UPDATE",
      targetModuleId: moduleId,
      features: {
        search: { enabled: true, fields: ["note"], placeholder: "Search notes…" },
        stats: [{ label: "Rows", op: "count" }],
        defaultSort: { field: "note", dir: "asc" },
      },
      explanation: "Turns it into a small dashboard.",
    },
  ]);
  check("it is built too, with nobody tapping anything", isBuilt(changed));
  if (!isBuilt(changed)) show(changed);

  // Built is a word. This is the section actually carrying it.
  const { data: schema } = await admin
    .from("ui_schemas")
    .select("schema_json, version")
    .eq("module_id", moduleId)
    .order("version", { ascending: false })
    .limit(1)
    .single();
  check("the live section really has the change", schema?.schema_json?.features?.search?.enabled === true);
  check("and it is a new version, so the old one is still there", (schema?.version ?? 0) > 1);

  // A rule was the last thing held back, because it keeps writing to
  // rows after it is built. The screen now says nothing waits.
  console.log("\nand a rule that runs by itself afterwards");
  const ruled = await submit(`Scope check ${stamp} — rule`, [
    {
      changeType: "AUTOMATION_ADD",
      targetModuleId: moduleId,
      automation: {
        name: `Scope ${stamp} stamp`,
        definition: {
          trigger: { type: "record_created" },
          actions: [
            { type: "set_fields", target: { self: true }, set: { stage: { const: "seen" } } },
          ],
        },
      },
      explanation: "Marks a new row as seen.",
    },
  ]);
  check("it is built too", isBuilt(ruled));
  if (!isBuilt(ruled)) show(ruled);
  const { count: rules } = await admin
    .from("automations")
    .select("id", { count: "exact", head: true })
    .eq("module_id", moduleId);
  check("and the rule is really on the section", (rules ?? 0) >= 1);

  // The ceiling was five a day. Three builds have happened above on
  // this project already, so landing three more proves it is gone —
  // and proves it in the one place the old code counted.
  console.log("\nand there is no ceiling to run into");
  let over = null;
  for (let i = 0; i < 3; i++) {
    over = await submit(`Scope check ${stamp} — field ${i}`, [
      {
        changeType: "FIELD_ADD",
        targetModuleId: moduleId,
        newSchema: {
          columns: [
            { field: "note", label: "Note", type: "text" },
            { field: "stage", label: "Stage", type: "text" },
            ...Array.from({ length: i + 1 }, (_, k) => ({
              field: `extra_${k}`,
              label: `Extra ${k}`,
              type: "text",
            })),
          ],
        },
        explanation: "One more field.",
      },
    ]);
    if (!isBuilt(over)) break;
  }
  check("the sixth automatic build of the day still goes in", isBuilt(over));
  if (!isBuilt(over)) show(over);
  const { count: autos } = await admin
    .from("build_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("auto_built", true)
    .gt("built_at", new Date(Date.now() - 864e5).toISOString());
  check("and more than five are counted against today", (autos ?? 0) > 5);

  // The one thing the setting must never reach, however it is set.
  console.log("\nbut removing a section, never");
  const gone = await tool("submit_design", {
    request: `Scope check ${stamp} — delete`,
    plans: [{ changeType: "MODULE_DELETE", targetModuleId: moduleId, deleteConfirmName: slug }],
  });
  check("it is refused", !isBuilt(gone) && gone?.status !== "waiting for approval");
  if (gone?.request_id) madeRequests.push(gone.request_id);
  const { data: still } = await admin.from("modules").select("id").eq("id", moduleId).maybeSingle();
  check("and the section is still there", !!still);

  // Nobody tapped anything, so if the server does not write it down
  // the app changes and the merchant's history stays blank.
  console.log("\nand the merchant can read what happened without being there");
  const { data: thread } = await admin
    .from("conversations")
    .select("id")
    .eq("project_id", project.id)
    .eq("title", "Changes from your AI")
    .maybeSingle();
  aiThreadId = thread?.id ?? null;
  check("an automatic build is written to the AI's own thread", !!aiThreadId);
  if (aiThreadId) {
    const { data: msgs } = await admin
      .from("messages")
      .select("role, content")
      .eq("conversation_id", aiThreadId)
      .order("created_at", { ascending: false })
      .limit(20);
    check(
      "with what was asked",
      (msgs ?? []).some((m) => m.role === "user" && m.content.includes(stamp))
    );
    check(
      "and what came of it",
      (msgs ?? []).some((m) => m.role === "assistant" && m.content.startsWith("✅"))
    );
  }
} finally {
  await setAuto(project.auto_build === true);
  const after = (await admin.from("projects").select("auto_build").eq("id", project.id).single()).data;
  check("the setting is back as it was", after?.auto_build === (project.auto_build === true));

  // The section goes, and the rule and schemas go with it — both are
  // ON DELETE CASCADE from modules. Only ids this run created.
  if (moduleId) await admin.from("modules").delete().eq("id", moduleId);
  for (const id of madeRequests) await admin.from("build_requests").delete().eq("id", id);
  const { data: leftovers } = await admin
    .from("modules")
    .select("id")
    .eq("project_id", project.id)
    .ilike("name", `${slug}%`);
  for (const m of leftovers ?? []) await admin.from("modules").delete().eq("id", m.id);
  // The thread this run caused, and nothing older: only the messages
  // carrying this run's stamp, and the thread itself only if that was
  // all of them.
  if (aiThreadId) {
    const { data: msgs } = await admin
      .from("messages")
      .select("id, content")
      .eq("conversation_id", aiThreadId);
    const mine = (msgs ?? []).filter((m) => m.content.includes(stamp));
    for (const m of mine) await admin.from("messages").delete().eq("id", m.id);
    if (mine.length === (msgs ?? []).length) {
      await admin.from("conversations").delete().eq("id", aiThreadId);
    }
  }
  console.log("\nthe project is back as it was");
}

console.log(fails.length === 0 ? "\nautomatic means automatic" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
