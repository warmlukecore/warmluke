// Two people tapping Build on the same card.
//
// The panel used to stamp approval and call /api/apply with no request
// id at all, so nothing was claimed before the writes began and the
// status only moved to built once they were done. Two tabs, a second
// tap before the first rerendered, or the app racing the connected
// client all ran the same plans at the same time — and a section got
// built twice.
//
// The MCP path had always claimed first. This is the app path being
// held to the same rule, in the one endpoint both now go through.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-apply-claim.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin.from("projects").select("id").limit(1).single();

const stamp = Date.now().toString(36);
const NAME = `race-check-${stamp}`;
const made = [];

const plans = [
  {
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: { name: NAME, nav_label: `Race Check ${stamp}`, icon: "table" },
    newSchema: {
      columns: [{ field: "note", label: "Note", type: "text" }],
      view: { type: "table" },
    },
    explanation: "Somewhere to write a note.",
  },
];

const apply = (requestId) =>
  fetch(`${APP}/api/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner.session.access_token}`,
    },
    body: JSON.stringify({ projectId: project.id, plans, requestId }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const raise = async () => {
  const when = new Date().toISOString();
  const { data } = await admin
    .from("build_requests")
    .insert({
      project_id: project.id,
      requested_by: owner.user.id,
      request: `race ${stamp}`,
      plans,
      status: "pending",
      approved_at: when,
      approved_by: owner.user.id,
    })
    .select("id")
    .single();
  made.push(data.id);
  return data.id;
};

const sections = async () =>
  (
    await admin
      .from("modules")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("name", NAME)
  ).count ?? 0;

try {
  console.log("two taps at once, on the same card");
  const reqId = await raise();
  const [a, b] = await Promise.all([apply(reqId), apply(reqId)]);
  const ok = [a, b].filter((r) => r.status === 200);
  const refused = [a, b].filter((r) => r.status === 409);

  check("only one of them builds", ok.length === 1);
  check("the other is told it is already happening", refused.length === 1);
  check("and told so plainly", /already being built/i.test(refused[0]?.body?.error ?? ""));
  // The whole point. This used to be 2.
  check("the section exists once, not twice", (await sections()) === 1);

  const row = (
    await admin.from("build_requests").select("status, outcome").eq("id", reqId).single()
  ).data;
  check("and the request is recorded as built", row?.status === "built");
  check("with what it built", (row?.outcome?.applied ?? []).length === 1);

  console.log("\nand a third tap, after it is done");
  const late = await apply(reqId);
  check("changes nothing", late.status !== 200);
  check("and still one section", (await sections()) === 1);
} finally {
  await admin.from("modules").delete().eq("project_id", project.id).eq("name", NAME);
  for (const id of made) await admin.from("build_requests").delete().eq("id", id);
  check("nothing this check built is left behind", (await sections()) === 0);
}

console.log(fails.length === 0 ? "\none card, one build" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
