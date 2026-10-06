// Did it work? (0190), on the check project: a build four days old whose
// section nobody has used is asked about in its asker's bell, and only
// theirs; a row added since takes the question away; the answer is kept
// once and only by them. The judge's page then reads the owner's answer as
// a mark, an administrator's mark overrides it, and the agreement counts
// both. The Agents screen counts the answers.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-follow-up-live.mjs
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
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this makes projects and accounts of its own, so it runs only there");
  process.exit(0);
}
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anon), env);
if (!me.session) {
  console.log(`could not sign in as the check user — ${me.why}`);
  process.exit(1);
}
const as = (token) => createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
const owner = as(me.session.access_token);

// Someone else, who must neither see nor answer it.
const stamp = Date.now();
const { data: made } = await admin.auth.admin.createUser({
  email: `follow-up-stranger-${stamp}@warmluke.test`,
  password: "Test-passw0rd!",
  email_confirm: true,
});
const strangerSession = await createClient(url, anon).auth.signInWithPassword({
  email: `follow-up-stranger-${stamp}@warmluke.test`,
  password: "Test-passw0rd!",
});
const stranger = as(strangerSession.data.session.access_token);

const project = await throwawayProject(admin, me.user.id, "follow-up");
try {
  const { data: mod } = await admin
    .from("modules")
    .insert({
      project_id: project.id,
      name: "cod-calls",
      nav_label: "COD calls",
      icon: "table",
      route: "/x",
      sort_order: 1,
    })
    .select("id")
    .single();
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString();
  const { data: convo } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "COD calls", created_by: me.user.id })
    .select("id")
    .single();
  const { data: design } = await admin
    .from("messages")
    .insert({
      conversation_id: convo.id,
      role: "assistant",
      content: "{}",
      payload: { type: "blueprint" },
      created_at: fourDaysAgo,
    })
    .select("id")
    .single();
  const { data: build } = await admin
    .from("messages")
    .insert({
      conversation_id: convo.id,
      role: "assistant",
      content: "",
      payload: { type: "build", status: "built", made: [mod.id], design: design.id, finished_at: fourDaysAgo },
      created_at: fourDaysAgo,
    })
    .select("id")
    .single();
  const waiting = async (db) =>
    ((await db.rpc("abo_follow_ups", { p_project: project.id })).data ?? []).map((f) => f.build_id);

  console.log("the question");
  check("a build nobody has used is asked about", (await waiting(owner)).includes(build.id));
  const one = ((await owner.rpc("abo_follow_ups", { p_project: project.id })).data ?? [])[0];
  check("named by its sections", JSON.stringify(one?.sections) === JSON.stringify(["COD calls"]));
  check("in no one else's bell", (await waiting(stranger)).length === 0);
  const { data: row } = await admin
    .from("records")
    .insert({ module_id: mod.id, data: { name: "x" } })
    .select("id")
    .single();
  check("a row added since takes it away", !(await waiting(owner)).includes(build.id));
  await admin.from("records").delete().eq("id", row.id);
  check("and it is back when that row is gone", (await waiting(owner)).includes(build.id));

  console.log("\nthe answer");
  const theirs = await stranger.rpc("abo_answer_follow_up", { p_build: build.id, p_answer: "fine" });
  check("nobody else can answer it", !!theirs.error);
  const bad = await owner.rpc("abo_answer_follow_up", { p_build: build.id, p_answer: "maybe" });
  check("an answer is fine or missed", !!bad.error);
  const said = await owner.rpc("abo_answer_follow_up", { p_build: build.id, p_answer: "missed" });
  check("the asker's answer is kept", !said.error && said.data === true);
  check("and the question goes", !(await waiting(owner)).includes(build.id));
  const again = await owner.rpc("abo_answer_follow_up", { p_build: build.id, p_answer: "fine" });
  check("it is answered once", !again.error && again.data === false);
  const direct = await owner
    .from("build_followups")
    .insert({ build_id: design.id, project_id: project.id, answer: "fine" });
  check("the table is not written directly", !!direct.error);

  console.log("\nthe judge, checked");
  const { data: judged } = await admin
    .from("judgements")
    .insert({
      project_id: project.id,
      source: "chat",
      ref: design.id,
      request: `Track COD calls ${stamp}`,
      built: "A COD calls section",
      judge: { addresses: 0.8, unmet: [] },
      model: "check",
      ms: 1,
    })
    .select("id")
    .single();
  const queue = async () =>
    (await owner.rpc("abo_admin_judge_queue", { p_limit: 200, p_account: me.user.id, p_app: project.id })).data;
  let q = await queue();
  let item = q?.items?.find((i) => i.id === judged.id);
  check("the owner's answer reads as a mark", item?.owner_said === "missed" && item?.marked === null);
  check(
    "and the judge's yes against it is a disagreement",
    q?.agreement?.marked === 1 && q.agreement.agree === 0 && q.agreement.judge_yes_people_no === 1
  );
  await owner.rpc("abo_admin_judge_label", { p_judgement: judged.id, p_right: true });
  q = await queue();
  check("an administrator's mark overrides it", q?.agreement?.agree === 1 && q.agreement.judge_yes_people_no === 0);
  await owner.rpc("abo_admin_judge_label", { p_judgement: judged.id, p_right: null });
  q = await queue();
  item = q?.items?.find((i) => i.id === judged.id);
  check("and taken back, the owner's word counts again", item?.marked === null && q?.agreement?.agree === 0);
  const notAdmin = await stranger.rpc("abo_admin_judge_queue", { p_limit: 5 });
  check("the queue is an administrator's alone", !!notAdmin.error);
  const notAdminMark = await stranger.rpc("abo_admin_judge_label", { p_judgement: judged.id, p_right: false });
  check("and so is a mark", !!notAdminMark.error);

  console.log("\nthe Agents screen");
  const cards =
    (await owner.rpc("abo_admin_agents", { p_days: 1, p_account: me.user.id, p_app: project.id })).data?.agents ?? [];
  const followUp = cards.find((g) => g.name === "follow-up");
  check("counts the answer", followUp?.runs === 1 && followUp.outcomes?.["not what they meant"] === 1);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  if (made?.user) await admin.auth.admin.deleteUser(made.user.id);
}

console.log(
  fails.length === 0 ? "\nan unused build is asked about once, and its answer counts" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
