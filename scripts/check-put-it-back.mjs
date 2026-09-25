// Putting a build back.
//
// The setting now builds changes to sections the merchant already has,
// without asking. That is what they wanted, and it is only safe to
// want if the answer to "no, not like that" is one tap — every schema
// version was already kept, but nothing in the app ever offered one
// back, so a section rewritten overnight stayed rewritten.
//
// Driven through submit_design, which runs no model, so this proves
// the undo rather than the engine.
//
//   node scripts/check-put-it-back.mjs

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
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const owner = await signInAsCheckUser(client, env);
if (!owner.session) {
  console.log(`could not sign in as the owner — ${owner.why}`);
  process.exit(1);
}
const token = owner.session.access_token;
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
// A project for this run only — the check user's, not the merchant's.
// Everything this makes is under it, and remove() takes it all.
const project = await throwawayProject(admin, owner.user.id, "put-it-back");

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
const undoCall = (messageId) =>
  fetch(`${APP}/api/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId: project.id, messageId }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);
const stamp = Date.now().toString(36);
const slug = `back-${stamp}`;
const madeRequests = [];
let moduleId = null;
let aiThreadId = null;

const submit = async (request, plans) => {
  const r = await tool("submit_design", { request, plans });
  if (r?.request_id) madeRequests.push(r.request_id);
  return r;
};
const isBuilt = (r) => r?.status === "built" || r?.status === "partly built";
const latestSchema = async () =>
  (
    await admin
      .from("ui_schemas")
      .select("schema_json, version, change_description")
      .eq("module_id", moduleId)
      .order("version", { ascending: false })
      .limit(1)
      .single()
  ).data;
/** The message the build wrote, which is what the button hangs off. */
const lastBuildMessage = async () =>
  (
    await admin
      .from("messages")
      .select("id, payload, content")
      .eq("conversation_id", aiThreadId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
  ).data;

try {
  await setAuto(true);

  console.log("a section, built without asking");
  const made = await submit(`Put back ${stamp} — new section`, [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: slug, nav_label: `Back ${stamp}`, icon: "table" },
      newSchema: {
        columns: [{ field: "note", label: "Note", type: "text" }],
        view: { type: "table" },
      },
      explanation: "Somewhere to write a note.",
    },
  ]);
  check("it is built", isBuilt(made));
  if (!isBuilt(made)) show(made);
  moduleId = (made?.built ?? []).map((b) => b.moduleId).find(Boolean) ?? null;

  const thread = (
    await admin
      .from("conversations")
      .select("id")
      .eq("project_id", project.id)
      .eq("title", "Changes from your AI")
      .maybeSingle()
  ).data;
  aiThreadId = thread?.id ?? null;

  // A whole new section is deliberately not offered: taking it back
  // means deleting it and every row in it, which is the one thing the
  // app makes the owner type a name to confirm.
  const firstMsg = await lastBuildMessage();
  check("a brand new section is not offered back", !firstMsg?.payload?.undo);

  console.log("\nthen a change to it, also without asking");
  const changed = await submit(`Put back ${stamp} — dashboard`, [
    {
      changeType: "FEATURE_UPDATE",
      targetModuleId: moduleId,
      features: {
        search: { enabled: true, fields: ["note"], placeholder: "Search notes…" },
        stats: [{ label: "Rows", op: "count" }],
      },
      explanation: "Turns it into a small dashboard.",
    },
  ]);
  check("it is built", isBuilt(changed));
  if (!isBuilt(changed)) show(changed);
  const after = await latestSchema();
  check("and the section really carries it", after?.schema_json?.features?.search?.enabled === true);

  const msg = await lastBuildMessage();
  const offered = msg?.payload?.undo ?? [];
  check("the build message offers to put it back", offered.length === 1);
  check("and says what would go back", /layout/.test(offered[0]?.what ?? ""));
  if (offered.length !== 1) show(msg?.payload);

  console.log("\nand putting it back");
  const undone = await undoCall(msg.id);
  check("the request is accepted", undone.status === 200);
  // "Nothing could be put back" also contains the words, so this asks
  // the question that matters: did anything actually go back.
  check("and something actually went back", (undone.body?.done ?? []).length > 0);
  if ((undone.body?.done ?? []).length === 0) show(undone.body);

  const restored = await latestSchema();
  check("the change is gone from the live section", !restored?.schema_json?.features?.search?.enabled);
  // Nothing is rewritten and nothing is dropped: going back is itself
  // a new version, so the history reads as what really happened.
  check("and it went back as a new version", (restored?.version ?? 0) > (after?.version ?? 0));
  check("which says it was a putting back", /put back/i.test(restored?.change_description ?? ""));
  const { count: versions } = await admin
    .from("ui_schemas")
    .select("id", { count: "exact", head: true })
    .eq("module_id", moduleId);
  check("and the version it undid is still there to go forward to", (versions ?? 0) >= 3);

  // The one that made this worth building: a change nobody watched.
  console.log("\nand the putting back is written down too");
  const record = await lastBuildMessage();
  check("the thread says it happened", /put back/i.test(record?.content ?? ""));

  // The one that would have lost the merchant's own work.
  //
  // Putting back writes what the section held BEFORE that build, on
  // top of whatever it holds now. If they changed something since,
  // that copy does not contain it — so an old build's undo would take
  // the newer change with it, silently. Refused instead.
  console.log("\nbut not once the section has moved on");
  const moved = await submit(`Put back ${stamp} — one more field`, [
    {
      changeType: "FIELD_ADD",
      targetModuleId: moduleId,
      newSchema: {
        columns: [
          { field: "note", label: "Note", type: "text" },
          { field: "extra", label: "Extra", type: "text" },
        ],
      },
      explanation: "One more field.",
    },
  ]);
  check("a later change is built", isBuilt(moved));
  const movedMsg = await lastBuildMessage();
  const newer = await submit(`Put back ${stamp} — and another`, [
    {
      changeType: "FIELD_ADD",
      targetModuleId: moduleId,
      newSchema: {
        columns: [
          { field: "note", label: "Note", type: "text" },
          { field: "extra", label: "Extra", type: "text" },
          { field: "extra_two", label: "Extra two", type: "text" },
        ],
      },
      explanation: "And another.",
    },
  ]);
  check("and then another on top of it", isBuilt(newer));
  // Grabbed now, not after the refusal below: a refusal is written to
  // the thread too, so by then "the last message" is that.
  const newestMsg = await lastBuildMessage();
  const before = await latestSchema();
  const stale = await undoCall(movedMsg.id);
  check("undoing the older one is refused", (stale.body?.done ?? []).length === 0);
  check("and says the section has changed since", /changed .* since/i.test((stale.body?.couldNot ?? []).join(" ")));
  if ((stale.body?.done ?? []).length > 0) show(stale.body);
  const untouched = await latestSchema();
  check("the newer work is still there", untouched?.version === before?.version);
  check(
    "and the field it added is still on the section",
    (untouched?.schema_json?.columns ?? []).some((c) => c.field === "extra_two")
  );
  // And the newest one can still be put back, so the guard is about
  // order rather than about refusing everything.
  const fine = await undoCall(newestMsg.id);
  check("the newest one still goes back", (fine.body?.done ?? []).length > 0);
  if ((fine.body?.done ?? []).length === 0) show(fine.body);

  // Rows a build seeded. Only the untouched ones go: a seeded row
  // somebody has since typed into is their row now.
  console.log("\nand rows it seeded come out, except the one somebody edited");
  const seeded = await submit(`Put back ${stamp} — seed`, [
    {
      changeType: "RECORD_SEED",
      targetModuleId: moduleId,
      newRecords: [{ note: "one" }, { note: "two" }, { note: "three" }],
      explanation: "Three example rows.",
    },
  ]);
  check("the rows are built", isBuilt(seeded));
  if (!isBuilt(seeded)) show(seeded);
  const seedMsg = await lastBuildMessage();
  const seedStep = (seedMsg?.payload?.undo ?? [])[0];
  check("and offered back by id, all three", seedStep?.kind === "rows" && seedStep.recordIds?.length === 3);
  // The merchant types into one of them.
  await admin
    .from("records")
    .update({ data: { note: "two, but mine now" }, updated_at: new Date(Date.now() + 1000).toISOString() })
    .eq("id", seedStep.recordIds[1]);
  const seedBack = await undoCall(seedMsg.id);
  check("putting them back is accepted", (seedBack.body?.done ?? []).length > 0);
  if ((seedBack.body?.done ?? []).length === 0) show(seedBack.body);
  const { data: left } = await admin.from("records").select("id, data").in("id", seedStep.recordIds);
  check("two untouched rows are gone", (left ?? []).length === 1);
  check("and the edited one is kept", (left ?? [])[0]?.data?.note === "two, but mine now");
  check("and the line says so", /1 edited since and kept/.test((seedBack.body?.done ?? []).join(" ")));

  // A section renamed, and put back — unless it was renamed again.
  console.log("\nand a section's name comes back, unless it was renamed again");
  const renamed = await submit(`Put back ${stamp} — rename`, [
    {
      changeType: "MODULE_UPDATE",
      targetModuleId: moduleId,
      moduleUpdate: { nav_label: `Back ${stamp} renamed` },
      explanation: "A better name.",
    },
  ]);
  check("the rename is built", isBuilt(renamed));
  if (!isBuilt(renamed)) show(renamed);
  const renameMsg = await lastBuildMessage();
  const renameStep = (renameMsg?.payload?.undo ?? [])[0];
  check(
    "and offered back with what it said before",
    renameStep?.kind === "module" && renameStep.was?.nav_label === `Back ${stamp}`
  );
  const renameBack = await undoCall(renameMsg.id);
  check("the old name is put back", (renameBack.body?.done ?? []).length > 0);
  if ((renameBack.body?.done ?? []).length === 0) show(renameBack.body);
  const { data: named } = await admin.from("modules").select("nav_label").eq("id", moduleId).single();
  check("and the section says it", named?.nav_label === `Back ${stamp}`);
  // Renamed twice: the first build's undo is not the second's to undo.
  const again = await submit(`Put back ${stamp} — rename again`, [
    {
      changeType: "MODULE_UPDATE",
      targetModuleId: moduleId,
      moduleUpdate: { nav_label: `Back ${stamp} second` },
      explanation: "Another name.",
    },
  ]);
  check("a second rename is built", isBuilt(again));
  const secondMsg = await lastBuildMessage();
  await submit(`Put back ${stamp} — rename third`, [
    {
      changeType: "MODULE_UPDATE",
      targetModuleId: moduleId,
      moduleUpdate: { nav_label: `Back ${stamp} third` },
      explanation: "A third.",
    },
  ]);
  const staleRename = await undoCall(secondMsg.id);
  check("undoing the second after a third is refused", (staleRename.body?.done ?? []).length === 0);
  check(
    "and says it was changed again since",
    /changed again since/.test((staleRename.body?.couldNot ?? []).join(" "))
  );

  // The same putting back, asked for from where the build was asked
  // for. A merchant who built it by talking to their own assistant
  // should be able to undo it by talking to their own assistant.
  console.log("\nand an assistant can put its own build back");
  {
    const built = await submit(`Put back ${stamp} — by tool`, [
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: moduleId,
        features: { stats: [{ label: "Rows", op: "count" }] },
        explanation: "A count, to be taken off again.",
      },
    ]);
    check("the change is built", isBuilt(built));
    const withStat = await latestSchema();
    check("and the section carries it", (withStat?.schema_json?.features?.stats ?? []).length === 1);

    const back = await tool("undo_build", { request_id: built.request_id });
    check("undo_build puts it back", back?.status === "put back");
    check("and says what came off", (back?.put_back ?? []).length > 0);
    if (back?.status !== "put back") show(back);

    const now = await latestSchema();
    check("the stat is gone from the live section", (now?.schema_json?.features?.stats ?? []).length === 0);
    // Same rule as the button: nothing rewritten, a new version on
    // top, so the history still reads as what happened.
    check("and it went back as a new version", (now?.version ?? 0) > (withStat?.version ?? 0));
    const said = await lastBuildMessage();
    check("and their thread says so", /put back/i.test(said?.content ?? ""));

    // Asking twice must not undo the undo. The second call finds the
    // section already back and has nothing to restore over it.
    const again = await tool("undo_build", { request_id: built.request_id });
    const afterTwice = await latestSchema();
    check("asking twice changes nothing more", (afterTwice?.schema_json?.features?.stats ?? []).length === 0);
    if (again?.status === "put back" && (afterTwice?.version ?? 0) > (now?.version ?? 0)) {
      // Allowed, because putting back what is already back is a
      // no-op in content — but it must not resurrect the stat.
      check("and certainly does not bring it back", true);
    }
  }

  console.log("\nand a build nobody made here cannot be put back");
  {
    // A request raised by some other client. The app's own token may
    // undo anything of theirs, so this asks the database's question
    // instead: the row says another client raised it.
    const { data: theirs } = await admin
      .from("build_requests")
      .insert({
        project_id: project.id,
        requested_by: owner.user.id,
        client_id: "cl_somebody_else",
        request: `Put back ${stamp} — not ours`,
        status: "built",
        outcome: { applied: [], errors: [] },
      })
      .select("id, client_id")
      .single();
    check("it is on record as another client's", theirs?.client_id === "cl_somebody_else");
    const refused = await tool("undo_build", { request_id: theirs.id });
    // The app's token is not a client, so it is allowed — and finds
    // nothing recorded to put back, which is the honest answer.
    check("and the answer says there is nothing to put back", refused?.status === "nothing to put back");
    if (!refused?.status) show(refused);
  }

  console.log("\nand a message with nothing to put back is refused");
  const nothing = await undoCall(firstMsg.id);
  check("it is a plain no, not a crash", nothing.status === 400);
  check("and says why", /nothing on that message/i.test(nothing.body?.error ?? ""));

  console.log("\nand a rule can be switched back off");
  const ruled = await submit(`Put back ${stamp} — rule`, [
    {
      changeType: "AUTOMATION_ADD",
      targetModuleId: moduleId,
      automation: {
        name: `Back ${stamp} stamp`,
        definition: {
          trigger: { type: "record_created" },
          actions: [{ type: "set_fields", target: { self: true }, set: { note: { const: "seen" } } }],
        },
      },
      explanation: "Marks a new row as seen.",
    },
  ]);
  check("the rule is built", isBuilt(ruled));
  if (!isBuilt(ruled)) show(ruled);
  const ruleMsg = await lastBuildMessage();
  const ruleStep = (ruleMsg?.payload?.undo ?? [])[0];
  check("and offered back by id, not by name", typeof ruleStep?.automationId === "string");
  const ruleId = ruleStep?.automationId;

  // A rule of the same name on ANOTHER section. automation_disable
  // matches on project and name, so the old undo switched this one off
  // too — a rule on a section nobody had asked about.
  const bystander = (
    await admin
      .from("automations")
      .insert({
        project_id: project.id,
        module_id: null,
        name: `Back ${stamp} stamp`,
        enabled: true,
        definition: { trigger: { type: "record_created" }, actions: [] },
      })
      .select("id")
      .single()
  ).data;

  const ruleUndone = await undoCall(ruleMsg.id);
  check("putting it back is accepted", ruleUndone.status === 200);
  const { data: rule } = await admin.from("automations").select("enabled").eq("id", ruleId).maybeSingle();
  // Switched off rather than deleted, so the run log stays readable —
  // the same choice AUTOMATION_REMOVE already makes.
  check("the rule stops running", rule?.enabled === false);
  check("but is still there to read", rule !== null);
  const { data: other } = await admin.from("automations").select("enabled").eq("id", bystander.id).maybeSingle();
  check("and a rule of the same name elsewhere is left alone", other?.enabled === true);
  await admin.from("automations").delete().eq("id", bystander.id);

  // AUTOMATION_ADD rewrites a rule of the same name on the same
  // section in place, keeping its id and its run history. Undoing that
  // has to give back the rule they had, not no rule at all.
  console.log("\nand a rule that was changed comes back changed");
  await admin.from("automations").update({ enabled: true }).eq("id", ruleId);
  const rewritten = await submit(`Put back ${stamp} — change that rule`, [
    {
      changeType: "AUTOMATION_ADD",
      targetModuleId: moduleId,
      automation: {
        name: `Back ${stamp} stamp`,
        definition: {
          trigger: { type: "record_created" },
          actions: [{ type: "set_fields", target: { self: true }, set: { note: { const: "changed" } } }],
        },
      },
      explanation: "Marks a new row as changed instead.",
    },
  ]);
  check("the change is built", isBuilt(rewritten));
  const { data: nowSays } = await admin.from("automations").select("id, definition").eq("id", ruleId).single();
  check("the same rule row was rewritten, not replaced", nowSays?.id === ruleId);
  check("and it says the new thing", JSON.stringify(nowSays?.definition).includes("changed"));
  const rewrittenMsg = await lastBuildMessage();
  check(
    "the offer says it goes back to what it said before",
    /what it said before/.test((rewrittenMsg?.payload?.undo ?? [])[0]?.what ?? "")
  );
  const putRuleBack = await undoCall(rewrittenMsg.id);
  check("putting it back is accepted", (putRuleBack.body?.done ?? []).length > 0);
  if ((putRuleBack.body?.done ?? []).length === 0) show(putRuleBack.body);
  const { data: backAgain } = await admin.from("automations").select("enabled, definition").eq("id", ruleId).single();
  check("the rule says what it said before, not nothing", JSON.stringify(backAgain?.definition).includes("seen"));
  check("and it is still running", backAgain?.enabled === true);

  // A section deleted after a build on it: the undo says so, not
  // "changed -3 times since".
  console.log("\nand an undo on a section that is gone says so");
  const { data: lastSchemaMsg } = await admin
    .from("messages")
    .select("id, payload")
    .eq("conversation_id", aiThreadId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false });
  const schemaMsg = (lastSchemaMsg ?? []).find((m) => (m.payload?.undo ?? []).some((u) => u.kind === "schema"));
  await admin.from("modules").delete().eq("id", moduleId);
  moduleId = null;
  const orphan = schemaMsg ? await undoCall(schemaMsg.id) : { body: {} };
  check("it is refused", (orphan.body?.done ?? []).length === 0);
  check("and says the section is no longer there", /no longer there/.test((orphan.body?.couldNot ?? []).join(" ")));
} finally {
  await setAuto(project.auto_build === true);
  const back = (await admin.from("projects").select("auto_build").eq("id", project.id).single()).data;
  check("the setting is back as it was", back?.auto_build === (project.auto_build === true));

  if (moduleId) await admin.from("modules").delete().eq("id", moduleId);
  for (const id of madeRequests) await admin.from("build_requests").delete().eq("id", id);
  const { data: leftovers } = await admin
    .from("modules")
    .select("id")
    .eq("project_id", project.id)
    .ilike("name", `${slug}%`);
  for (const m of leftovers ?? []) await admin.from("modules").delete().eq("id", m.id);
  if (aiThreadId) {
    const { data: msgs } = await admin.from("messages").select("id, content").eq("conversation_id", aiThreadId);
    // Only this run's, matched on its stamp — and the putting-back
    // lines, which name the section rather than the stamp.
    const mine = (msgs ?? []).filter((m) => m.content.includes(stamp) || /put back/i.test(m.content));
    for (const m of mine) await admin.from("messages").delete().eq("id", m.id);
    if (mine.length === (msgs ?? []).length) {
      await admin.from("conversations").delete().eq("id", aiThreadId);
    }
  }
  await project.remove();
  console.log("\nthe project is gone, and nothing of it is left");
}

console.log(fails.length === 0 ? "\nit can be taken back" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
