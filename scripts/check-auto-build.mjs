// Building without being asked, and refusing to.
//
// The switch is one boolean; the gate is the feature. What matters is
// that "yes, build things for me" does not quietly become "yes,
// rewrite the section my staff use every day" — so the refusals are
// checked, not just the happy path.
//
// The project's setting is put back at the end, and anything built
// here is removed.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-auto-build.mjs

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
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin
  .from("projects")
  .select("id, auto_build")
  .limit(1)
  .single();

const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);
const sectionCount = async () =>
  (
    await admin
      .from("modules")
      .select("*", { count: "exact", head: true })
      .eq("project_id", project.id)
  ).count;

/** Drives the tool the way an assistant does. */
const tool = async (name, args, id = 1) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};

const stamp = Date.now().toString(36);
const made = [];

try {
  console.log("with the setting off");
  await setAuto(false);
  const before = await sectionCount();
  const off = await tool("propose_change", {
    request: `Add a section called Off Check ${stamp} with a single text field for a note. Nothing else.`,
  });
  check("the design waits for approval", off.status === "waiting for approval");
  check("and nothing was built", (await sectionCount()) === before);
  if (off.request_id) await admin.from("build_requests").update({ status: "dismissed" }).eq("id", off.request_id);

  console.log("\nwith it on, and an addition");
  await setAuto(true);
  const on = await tool(
    "propose_change",
    {
      request: `Add a section called On Check ${stamp} with a single text field for a note. Nothing else, no rules.`,
    },
    2
  );
  const built = on.status === "built" || on.status === "partly built";
  check("it is built there and then", built);
  if (!built) console.log("     →", JSON.stringify(on).slice(0, 300));
  check("and the assistant is told what was built", Array.isArray(on.built) && on.built.length > 0);
  for (const b of on.built ?? []) if (b.moduleId) made.push(b.moduleId);

  const row = (
    await admin
      .from("build_requests")
      .select("status, auto_built")
      .eq("project_id", project.id)
      .eq("auto_built", true)
      .order("built_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ).data;
  check("the row records that nobody approved it", row?.status === "built" && row.auto_built === true);

  console.log("\nbut not a rule that runs on every order");
  const ruled = await tool(
    "propose_change",
    {
      request: `In the section On Check ${stamp}, add a rule that sets the note to "seen" whenever a row is created.`,
    },
    3
  );
  check("it waits instead", ruled.status === "waiting for approval");
  check(
    "and says why the setting did not apply",
    typeof ruled.not_automatic_because === "string" && ruled.not_automatic_because.length > 0
  );
  if (ruled.not_automatic_because) console.log(`     → ${ruled.not_automatic_because}`);
  if (ruled.request_id) await admin.from("build_requests").update({ status: "dismissed" }).eq("id", ruled.request_id);

  console.log("\nand the day is counted");
  const { count } = await admin
    .from("build_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("auto_built", true)
    .gt("built_at", new Date(Date.now() - 864e5).toISOString());
  check("automatic builds are counted", (count ?? 0) >= 1);
} finally {
  await setAuto(project.auto_build === true);
  for (const id of made) await admin.from("modules").delete().eq("id", id);
  await admin
    .from("build_requests")
    .update({ status: "dismissed" })
    .eq("project_id", project.id)
    .in("status", ["pending", "built"]);
  console.log("\nthe project is back as it was");
}

console.log(fails.length === 0 ? "\nit builds only what it may" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
