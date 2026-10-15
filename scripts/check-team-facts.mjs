// Who does what, and how long a restock takes (lib/team-facts, 0222).
//
// Pure: each answer is a line of what Luke knows, of the kind the work
// stands on, one a topic; "me" is the owner; a restock time is a whole
// number of days; what was said reads back into the form. Live, on the
// check project, under the owner's own rights: saving keeps the lines and
// the restock time, Luke reads them first whatever else he knows, saving
// again replaces rather than doubles, and skipping marks it asked.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-team-facts.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import {
  NO_ANSWERS,
  TEAM_TOPICS,
  answersFrom,
  saveTeam,
  skipTeam,
  teamNotes,
  teamProblems,
} from "../src/lib/team-facts.ts";
import { notesFor } from "../src/lib/memory.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("\nthe answers, as lines of what Luke knows");
const answers = {
  ...NO_ANSWERS,
  packing: "Ravi",
  customers: "me",
  ads: " An agency ",
  tools: "Shiprocket, Razorpay",
  restock_days: "10",
};
const notes = teamNotes(answers);
check("one line an answer, the blank ones left out", notes.length === 5);
check(
  "who does what is a line the work stands on, on its own topic",
  notes[0].kind === "team" && notes[0].topic === "team: packing" && notes[0].note === "Packing and shipping: Ravi"
);
check(
  "“me” is the owner, never someone called Me",
  notes[1].note === "Customer messages and returns: the owner themselves"
);
check("spaces trimmed", notes[2].note === "Ads: An agency");
check(
  "the restock time is a lead time, said in days",
  notes.at(-1).kind === "lead_time" && notes.at(-1).note === "A restock usually takes 10 days to arrive"
);
check(
  "every line is the owner's",
  notes.every((n) => n.source === "owner")
);
check(
  "a restock time that is not a number of days is refused",
  !!teamProblems({ ...NO_ANSWERS, restock_days: "ten" }).restock_days
);
check("nor one past a year", !!teamProblems({ ...NO_ANSWERS, restock_days: "400" }).restock_days);
check("nothing at all is fine: every answer is optional", Object.keys(teamProblems(NO_ANSWERS)).length === 0);
const back = answersFrom(
  notes.map((n) => ({ note: n.note, topic: n.topic })),
  10
);
check(
  "what was said reads back into the form, “me” as “Me”",
  back.packing === "Ravi" &&
    back.customers === "Me" &&
    back.tools === "Shiprocket, Razorpay" &&
    back.restock_days === "10"
);

// Live, on the check project.
const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`\n${envFile} does not declare CHECK_PROJECT=1, and this writes; the table is not checked`);
  process.exit(fails.length === 0 ? 0 : 1);
}
const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anonKey), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const owner = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "team facts");

try {
  console.log("\nkept under the owner's own rights");
  // Chat taught more than the forty newest: the team is still read first.
  for (let i = 1; i <= 45; i++)
    await owner.from("merchant_notes").insert({ project_id: project.id, note: `Chat fact ${i}` });
  const saved = await saveTeam(owner, project.id, answers);
  check("the owner saves them", saved === null);
  const { data: row } = await admin
    .from("projects")
    .select("restock_days, team_asked_at")
    .eq("id", project.id)
    .single();
  check("the restock time is on the project, and it was asked", row?.restock_days === 10 && !!row?.team_asked_at);
  const read = await notesFor(owner, project.id);
  check(
    "Luke reads them first, past forty-five lines of chat",
    read.slice(0, 5).some((l) => l === "[team: packing] Packing and shipping: Ravi") &&
      read.slice(0, 5).some((l) => l.endsWith("A restock usually takes 10 days to arrive"))
  );

  console.log("\nanswered again, replaced");
  await saveTeam(owner, project.id, { ...answers, packing: "Sunita", ads: "", restock_days: "7" });
  const { data: lines } = await owner
    .from("merchant_notes")
    .select("note, topic")
    .eq("project_id", project.id)
    .in("topic", TEAM_TOPICS);
  const packing = (lines ?? []).filter((l) => l.topic === "team: packing");
  check("one line a topic, the new one", packing.length === 1 && packing[0].note === "Packing and shipping: Sunita");
  check("an answer cleared is gone", !(lines ?? []).some((l) => l.topic === "team: ads"));
  const { data: again } = await admin.from("projects").select("restock_days").eq("id", project.id).single();
  check("and the restock time is the new one", again?.restock_days === 7);

  console.log("\nskipped");
  await admin.from("projects").update({ team_asked_at: null }).eq("id", project.id);
  const skipped = await skipTeam(owner, project.id);
  const { data: asked } = await admin.from("projects").select("team_asked_at").eq("id", project.id).single();
  check("skipping marks it asked, so onboarding moves on", skipped === null && !!asked?.team_asked_at);
} finally {
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nwho does what is said once, kept, and read first");
process.exit(fails.length ? 1 : 0);
