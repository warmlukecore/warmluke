// A design in the chat is built once (0224): "Build it" pressed twice, or
// sent again after a dropped connection while the first still ran, builds
// it once and says so to the second; a third press after it is done does
// not build it again; put back, it can be built again. Live, on the check
// project, against the running app, under the owner's own rights.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-build-once.mjs
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
  console.log("not a check project: this builds sections of its own, so it runs only there");
  process.exit(0);
}
const APP = process.env.APP_URL ?? "http://localhost:3100";
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const token = me.session.access_token;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const project = await throwawayProject(admin, me.user.id, "build once");
const stamp = Date.now().toString(36);
const LABEL = `Built once ${stamp}`;

const post = (path, body) =>
  fetch(`${APP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

try {
  const { data: thread } = await admin
    .from("conversations")
    .insert({ project_id: project.id, title: "build once" })
    .select("id")
    .single();
  const { data: design } = await admin
    .from("messages")
    .insert({ conversation_id: thread.id, role: "assistant", content: "A design", payload: { type: "blueprint" } })
    .select("id")
    .single();
  const base = {
    targetModuleId: null,
    newModule: null,
    moduleUpdate: null,
    deleteConfirmName: null,
    features: null,
    automation: null,
    automationRemoveName: null,
    newRecords: null,
    explanation: "checking a design is built once",
  };
  // A section first, then the design: a column added to it, which can be put back.
  const made = await post("/api/apply", {
    projectId: project.id,
    plans: [
      {
        ...base,
        changeType: "NEW_MODULE",
        newModule: { name: `built-once-${stamp}`, nav_label: LABEL, icon: "table" },
        newSchema: { columns: [{ field: "order_no", label: "Order", type: "text" }] },
      },
    ],
  });
  const moduleId = made.json.results?.[0]?.moduleId;
  const plans = [
    {
      ...base,
      changeType: "FIELD_ADD",
      targetModuleId: moduleId,
      newSchema: {
        columns: [
          { field: "order_no", label: "Order", type: "text" },
          { field: "reason", label: "Reason", type: "text" },
        ],
      },
    },
  ];
  const build = () =>
    post("/api/apply", {
      projectId: project.id,
      plans,
      thread: { conversationId: thread.id, designId: design.id, sent: [0] },
    });
  // How many times the design landed: each build writes a version of the section's schema.
  const versions = async () =>
    (await admin.from("ui_schemas").select("version").eq("module_id", moduleId)).data?.length ?? 0;
  const before = await versions();
  const sections = async () => (await versions()) - before;

  console.log("pressed twice at once");
  const [a, b] = await Promise.all([build(), build()]);
  const won = [a, b].filter((r) => r.status === 200 && r.json.applied);
  const lost = [a, b].filter((r) => r.status === 409 && r.json.already);
  check("one builds it", won.length === 1);
  check("the other is told it is already built, or being built", lost.length === 1);
  check("and it landed once", (await sections()) === 1);

  console.log("\npressed again once it is done");
  const third = await build();
  check("not built again", third.status === 409 && third.json.already === true && (await sections()) === 1);

  console.log("\nput back, it can be built again");
  const undo = await post("/api/undo", { projectId: project.id, messageId: won[0].json.recorded });
  check("put back", undo.status === 200);
  const again = await build();
  check("and built again, once", again.status === 200 && again.json.applied === true);
  const third2 = await build();
  check("and not a third time", third2.status === 409 && third2.json.already === true);
} finally {
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\na design is built once, and again only once put back");
process.exit(fails.length ? 1 : 0);
