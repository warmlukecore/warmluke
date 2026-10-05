// What stuck (0181, 4c, 5 Oct), on the check project: a build that made a
// section, a week and a day ago, whose section has had a row put in since,
// counts as kept, by its week and by the example it was designed beside;
// the curator is handed it once, with what was asked; proposed, Luke does
// not read it; approved, he does, shape only; retired, never again.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-what-stuck.mjs
//
// Never with CI running: one check database.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { exampleFromBuild } from "../src/lib/curator.ts";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const owner = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!owner.session) {
  console.log(`could not sign in as the check user — ${owner.why}`);
  process.exit(1);
}
const db = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${owner.session.access_token}` } },
});
const project = await throwawayProject(admin, owner.user.id, "what-stuck");
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
let exampleId = null;

try {
  const { data: mod } = await admin
    .from("modules")
    .insert({
      project_id: project.id,
      name: "complaints",
      nav_label: "Complaints",
      icon: "table",
      route: "/x",
      sort_order: 1,
    })
    .select("id")
    .single();
  const { data: thread } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "Complaints" })
    .select("id")
    .single();
  const plans = [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: "complaints", nav_label: "Complaints", icon: "table" },
      newSchema: { columns: [{ field: "issue", label: "Issue", type: "text" }] },
      newRecords: null,
      explanation: "Complaints.",
    },
  ];
  await admin.from("messages").insert({
    conversation_id: thread.id,
    role: "user",
    content: "WhatsApp pe complaints aati hain, Asha +91 98100 00001 ka follow up chhoot gaya",
    created_at: ago(8.2),
  });
  const { data: design } = await admin
    .from("messages")
    .insert({
      conversation_id: thread.id,
      role: "assistant",
      content: "{}",
      payload: { type: "plans", plans, examples: ["seed-whatsapp-complaints"] },
      created_at: ago(8.1),
    })
    .select("id")
    .single();
  const { data: build } = await admin
    .from("messages")
    .insert({
      conversation_id: thread.id,
      role: "assistant",
      content: "Complaints.",
      payload: { type: "build", status: "built", design: design.id, made: [mod.id], finished_at: ago(8) },
      created_at: ago(8),
    })
    .select("id")
    .single();
  // In use since: a row put in a day ago.
  await admin
    .from("records")
    .insert({ project_id: project.id, module_id: mod.id, data: { issue: "Late" }, created_at: ago(1) });

  console.log("a kept build, counted");
  const { data: report, error } = await db.rpc("abo_admin_what_stuck", { p_weeks: 4 });
  check("the screen answers an administrator", !error && !!report);
  const week = (report?.weeks ?? []).find((w) => w.judged > 0);
  check("its week counts it a week on, and kept", !!week && week.kept >= 1);
  const ex = (report?.examples ?? []).find((e) => e.example === "seed-whatsapp-complaints");
  check("and the example it was shown gets the credit", !!ex && ex.kept >= 1);

  console.log("\nthe curator, once");
  const { data: kept } = await db.rpc("abo_admin_kept_builds", { p_limit: 50 });
  const mine = (kept ?? []).find((k) => k.build_id === build.id);
  check("handed this build, with what they asked", /complaints aati hain/.test(mine?.asked ?? ""));
  const words = exampleFromBuild(mine?.asked ?? null, mine?.design);
  check("put in words with their phone taken out", !!words && !/98100/.test(words.ask));
  await db.rpc("abo_admin_propose_example", {
    p_build: build.id,
    p_ask: words.ask,
    p_design: words.design,
    p_tags: words.tags,
  });
  await db.rpc("abo_admin_propose_example", {
    p_build: build.id,
    p_ask: words.ask,
    p_design: words.design,
    p_tags: words.tags,
  });
  const { data: rows } = await admin.from("design_examples").select("id, status").eq("from_build", build.id);
  exampleId = rows?.[0]?.id ?? null;
  check("proposed once, however often it is offered", rows?.length === 1 && rows[0].status === "proposed");
  const { data: again } = await db.rpc("abo_admin_kept_builds", { p_limit: 50 });
  check("and not handed again", !(again ?? []).some((k) => k.build_id === build.id));

  console.log("\nLuke reads it only once approved, and only its shape");
  const read = async () => ((await db.rpc("abo_design_examples")).data ?? []).find((e) => e.id === exampleId);
  check("proposed: not read", !(await read()));
  await db.rpc("abo_admin_decide_example", {
    p_id: exampleId,
    p_status: "active",
    p_ask: "WhatsApp complaints get no follow-up",
    p_design: null,
    p_why: "the alert is the follow-up",
    p_tags: ["complaint", "whatsapp", "follow"],
  });
  const seen = await read();
  check("approved: read, with the administrator's words", seen?.ask === "WhatsApp complaints get no follow-up");
  check("its shape alone: nothing says where it came from", seen && !("from_build" in seen) && !("decided_by" in seen));
  await db.rpc("abo_admin_decide_example", {
    p_id: exampleId,
    p_status: "retired",
    p_ask: null,
    p_design: null,
    p_why: null,
    p_tags: null,
  });
  check("retired: never read again", !(await read()));
  const { error: odd } = await db.rpc("abo_admin_decide_example", {
    p_id: exampleId,
    p_status: "proposed",
    p_ask: null,
    p_design: null,
    p_why: null,
    p_tags: null,
  });
  check("no other word than approved or retired", !!odd);
} finally {
  if (exampleId) await admin.from("design_examples").delete().eq("id", exampleId);
  await project.remove();
}

console.log(
  fails.length === 0 ? "\nwhat stuck is counted, and only an approved example is read" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
