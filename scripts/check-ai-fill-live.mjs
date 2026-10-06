// A rule's AI step, its day and its history (0182), on the check project:
// a run begins as a line of the rule's own history, ends saying what it
// filled and what it cost, once, and shows in the Rules screen's count; a
// rule switched off starts nothing; past the project's 200 a day none
// begins, and the bell says so once. No model is called: what a run does
// with the row is check-ai-fill's (pure).
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-ai-fill-live.mjs
//
// Never with CI running: one check database.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
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
const project = await throwawayProject(admin, owner.user.id, "ai-fill");

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
  const definition = {
    trigger: { type: "record_created" },
    actions: [{ type: "ai_fill", from: ["message"], set: ["issue"] }],
  };
  const { data: auto } = await admin
    .from("automations")
    .insert({ project_id: project.id, module_id: mod.id, name: "Read the message", definition, enabled: true })
    .select("id")
    .single();
  const { data: rec } = await admin
    .from("records")
    .insert({ project_id: project.id, module_id: mod.id, data: { message: "order aaya hi nahi" } })
    .select("id")
    .single();

  console.log("a run, in the rule's own history");
  const { data: run, error } = await db.rpc("abo_ai_fill_claim", { p_automation: auto.id, p_record: rec.id });
  check("it begins, for the owner's own rule", !error && typeof run === "string");
  const { data: line } = await admin.from("automation_runs").select("ok, detail").eq("id", run).single();
  check("as a line of that rule's history, running", line?.detail?.ai === "running");
  await db.rpc("abo_ai_fill_done", {
    p_run: run,
    p_ok: true,
    p_detail: { filled: ["issue"], left: [], usd: 0.0008, input: 900, output: 40, model: "check", ai: "forged" },
  });
  const { data: done } = await admin.from("automation_runs").select("ok, detail").eq("id", run).single();
  check("it ends saying what it filled and what it cost", done?.detail?.ai === "filled" && done.detail.usd === 0.0008);
  check("the ending is the database's word, never the caller's", done?.detail?.ai !== "forged");
  await db.rpc("abo_ai_fill_done", { p_run: run, p_ok: false, p_detail: { error: "again" } });
  const { data: once } = await admin.from("automation_runs").select("ok, detail").eq("id", run).single();
  check("and a run ends once", once?.ok === true && once.detail.ai === "filled");
  const { data: log } = await db.rpc("abo_rule_log", { p_project: project.id });
  check("the Rules screen counts it", JSON.stringify(log ?? "").includes(auto.id));
  // And the console's Agents screen (0185), for this app alone: no turn holds the AI step.
  const { data: seen } = await db.rpc("abo_admin_agents", { p_days: 1, p_account: owner.user.id, p_app: project.id });
  const step = seen?.agents?.find((g) => g.name === "ai step");
  check("the console's Agents screen counts it, for this app alone", step?.runs === 1 && step.outcomes?.filled === 1);
  check(
    "with what it cost and its tokens",
    Number(step?.usd) === 0.0008 && Number(step?.input) === 900 && Number(step?.output) === 40
  );
  check("and the tryout has a card of its own", !!seen?.agents?.some((g) => g.name === "tryout"));

  console.log("\na rule switched off");
  await admin.from("automations").update({ enabled: false }).eq("id", auto.id);
  const { data: offRun } = await db.rpc("abo_ai_fill_claim", { p_automation: auto.id, p_record: rec.id });
  check("starts nothing", offRun === null);
  await admin.from("automations").update({ enabled: true }).eq("id", auto.id);

  console.log("\nthe project's day");
  await admin.from("automation_runs").insert(
    Array.from({ length: 198 }, () => ({
      automation_id: auto.id,
      record_id: rec.id,
      ok: true,
      detail: { ai: "filled" },
    }))
  );
  const { data: last } = await db.rpc("abo_ai_fill_claim", { p_automation: auto.id, p_record: rec.id });
  check("the 200th of the day still begins", typeof last === "string");
  const { data: past } = await db.rpc("abo_ai_fill_claim", { p_automation: auto.id, p_record: rec.id });
  check("the 201st does not", past === null);
  await db.rpc("abo_ai_fill_claim", { p_automation: auto.id, p_record: rec.id });
  const { data: told } = await admin
    .from("alerts")
    .select("id, facts")
    .eq("automation_id", auto.id)
    .like("subject", "ai-limit %");
  check(
    "and the bell says so, once a day",
    told?.length === 1 && /AI steps paused until tomorrow/.test(told[0].facts?.title ?? "")
  );
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nan AI step is counted, kept to its day, and told" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
