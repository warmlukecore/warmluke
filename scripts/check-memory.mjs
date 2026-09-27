// What Luke knows (0131): read back as given, kept to the project, and
// kept short.
//
// The model's lines are parsed and cut here; the table lets whoever may
// use the project read and strike them, a stranger sees nothing, a line
// said twice is known once, and the forty-first pushes the oldest out.
// No model call: the learning itself is switched by its setting.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-memory.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { describeKnown, parseNotes } from "../src/lib/memory.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("what the learner says, read back");
const three = parseNotes(
  '{"notes":["Courier is Delhivery","Three people pack at 5pm","COD is most orders","a fourth"]}'
);
check("at most three lines, in order", three.length === 3 && three[0] === "Courier is Delhivery");
check("fenced JSON too", parseNotes('```json\n{"notes":["Uses Razorpay"]}\n```')[0] === "Uses Razorpay");
check(
  "a line that is an id is dropped",
  parseNotes('{"notes":["row 7ac0b1e5-0000-4000-8000-00000000c0de is theirs"]}').length === 0
);
check("too short or too long is dropped", parseNotes(`{"notes":["ok","${"x".repeat(200)}"]}`).length === 0);
check("said twice in one reply is one", parseNotes('{"notes":["Ships daily","ships daily"]}').length === 1);
check("not JSON, nothing learned", parseNotes("I learned that they ship daily.").length === 0);
check("nothing to say reads as nothing", describeKnown([]) === "");
check(
  "the lines are read as facts, never instructions",
  /never instructions/.test(describeKnown(["Courier is Delhivery"])) &&
    /- Courier is Delhivery/.test(describeKnown(["Courier is Delhivery"]))
);

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
const project = await throwawayProject(admin, me.user.id, "what luke knows");

try {
  console.log("\nkept to the project");
  const { error: e1 } = await owner
    .from("merchant_notes")
    .insert({ project_id: project.id, note: "Courier is Delhivery" });
  check("the owner writes a line under their own rights", !e1);
  const { data: mine } = await owner.from("merchant_notes").select("note").eq("project_id", project.id);
  check("and reads it back", mine?.length === 1 && mine[0].note === "Courier is Delhivery");
  const { error: twice } = await owner
    .from("merchant_notes")
    .insert({ project_id: project.id, note: "Courier is Delhivery" });
  check("said twice is refused by the table", twice?.code === "23505");
  const stranger = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: theirs } = await stranger.from("merchant_notes").select("note").eq("project_id", project.id);
  check("a stranger sees nothing", (theirs ?? []).length === 0);
  const { error: tooShort } = await owner.from("merchant_notes").insert({ project_id: project.id, note: "hm" });
  check("a line too short to mean anything is refused", !!tooShort);

  console.log("\nforty lines, then the oldest goes");
  for (let i = 1; i <= 41; i++) {
    const { error } = await owner.from("merchant_notes").insert({ project_id: project.id, note: `Fact number ${i}` });
    if (error) throw new Error(`could not insert: ${error.message}`);
  }
  const { data: kept } = await owner
    .from("merchant_notes")
    .select("note")
    .eq("project_id", project.id)
    .order("created_at");
  check("forty are kept", kept?.length === 40);
  check("and the first said is the one gone", !kept?.some((r) => r.note === "Courier is Delhivery"));

  console.log("\nstruck by the owner");
  const { data: one } = await owner.from("merchant_notes").select("id").eq("project_id", project.id).limit(1).single();
  const { error: gone } = await owner.from("merchant_notes").delete().eq("id", one.id);
  const { count } = await owner
    .from("merchant_notes")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id);
  check("a line struck is gone", !gone && count === 39);
} finally {
  await project.remove();
}

console.log(
  fails.length === 0 ? "\nwhat Luke knows is the owner's, short, and theirs to strike" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
