// What the owner's own assistant asked for reaches Luke, and only the
// owner's.
//
// Luke reads the app's structure fresh every turn, so a section their
// Claude built is visible to it — but not why, or that it was their
// Claude that asked. "Change what my AI just added" landed in a thread
// that had never heard of it. Now the last few requests are one line
// each in the turn's context: what was asked, whether it was built,
// what failed, what has since gone.
//
// The lines are checked without a database; the read is checked with
// one, through the owner's own client and through a stranger's.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-requests-context.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { describeRequests } from "../src/lib/describe.ts";
import { buildUserMessage } from "../src/lib/ai.ts";
import { recentRequests } from "../src/lib/engine.ts";

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

const now = new Date("2026-09-21T10:00:00Z");
const modules = [{ id: "m1", name: "cake-orders", nav_label: "Cake orders", icon: "table", source_table: null }];
const section = (name, nav_label) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: { name, nav_label, icon: "table", source_table: null },
  newSchema: { columns: [{ field: "customer", label: "Customer", type: "text" }] },
  explanation: "x",
});
const row = (extra) => ({
  id: "r1",
  request: "Track custom cake orders with the advance paid",
  status: "built",
  summary: null,
  plans: [section("cake-orders", "Cake orders")],
  outcome: { applied: [{ changeType: "NEW_MODULE", moduleId: "m1" }], errors: [] },
  client_id: "claude-desktop",
  created_at: "2026-09-21T08:00:00Z",
  built_at: "2026-09-21T08:05:00Z",
  ...extra,
});

console.log("what a request reads as");
{
  const [built] = describeRequests([row({})], modules, now);
  check(
    "a built one says when, through what, what was asked and what came of it",
    /^built 2 hours ago via claude-desktop: "Track custom cake orders with the advance paid" → built: New section: Cake orders$/.test(built)
  );

  const [partly] = describeRequests(
    [
      row({
        status: "partly_built",
        plans: [section("cake-orders", "Cake orders"), section("suppliers", "Suppliers")],
        outcome: { applied: [{ changeType: "NEW_MODULE", moduleId: "m1" }], errors: ["Suppliers: a section with that name exists"] },
      }),
    ],
    modules,
    now
  );
  check(
    "a partly built one says what landed and what did not",
    /partly built .* → built: New section: Cake orders · did not build 1 of 2: Suppliers: a section/.test(partly)
  );

  const [gone] = describeRequests(
    [row({ plans: [section("packing", "Packing")], outcome: { applied: [{ changeType: "NEW_MODULE", moduleId: "m9" }], errors: [] } })],
    modules,
    now
  );
  check("a section it built that is no longer here is said to be gone", /since removed: Packing/.test(gone));

  const [pending] = describeRequests([row({ status: "pending", outcome: null, built_at: null })], modules, now);
  check(
    "a pending one is plainly not built",
    /^pending 2 hours ago via claude-desktop — not built, waiting for the owner's yes: ".*" \(would: New section: Cake orders\)$/.test(pending)
  );
  const [dismissed] = describeRequests([row({ status: "dismissed", outcome: null })], modules, now);
  check("and a dismissed one was turned down", /^dismissed .* — turned down, not built/.test(dismissed));

  const long = "x".repeat(400);
  const [clipped] = describeRequests([row({ request: long })], modules, now);
  check(
    "a long request is quoted only as far as it can be recognised",
    clipped.includes("x".repeat(159) + "…") && !clipped.includes("x".repeat(200))
  );
  check("no plans is no crash", describeRequests([row({ plans: null, outcome: null })], modules, now)[0].startsWith("built "));
  const [old] = describeRequests([row({ built_at: "2026-09-17T08:00:00Z" })], modules, now);
  check("days read as days", /built 4 days ago/.test(old));
  check("none is none", describeRequests([], modules, now).length === 0);
}

console.log("\nand where it lands in the turn");
{
  const withLines = buildUserMessage("change that", null, null, null, [], [], ['built just now via claude: "a thing"']);
  check(
    "the block is there when there is something to say",
    /CONTEXT — what the owner's own connected assistant/.test(withLines) && /- built just now via claude/.test(withLines)
  );
  check(
    "it comes before the request, after the rules",
    withLines.indexOf("rules already running") < withLines.indexOf("connected assistant") &&
      withLines.indexOf("connected assistant") < withLines.indexOf("USER REQUEST:")
  );
  const without = buildUserMessage("hi", null, null, null, [], [], []);
  check("and absent when there is nothing — no empty heading to read past", !/connected assistant/.test(without));
}

if (!env.ADAPTIVE_OS_SERVICE_ROLE_KEY) {
  console.log("\n  skip  no service-role key — the read through RLS was not checked");
} else {
  console.log("\nread through the owner's own client, and a stranger's");
  const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
  const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
  const me = await signInAsCheckUser(client, env);
  if (!me.session) throw new Error(`no check user: ${me.why}`);
  const project = await throwawayProject(admin, me.user.id, "requests-context");
  const stamp = Date.now();
  const stranger = { email: `ctx_${stamp}@example.com`, password: `pw_${stamp}_aA1!` };
  const { data: made } = await admin.auth.admin.createUser({ ...stranger, email_confirm: true });
  try {
    const { error } = await admin.from("build_requests").insert({
      project_id: project.id,
      requested_by: me.user.id,
      client_id: "claude-desktop",
      request: "Track custom cake orders with the advance paid",
      plans: [section("cake-orders", "Cake orders")],
      status: "built",
      outcome: { applied: [{ changeType: "NEW_MODULE", moduleId: "m1" }], errors: [] },
      built_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    const mine = await recentRequests(client, project.id, modules);
    check(
      "the owner's turn is told about it",
      mine.length === 1 && /built just now via claude-desktop: "Track custom cake orders/.test(mine[0])
    );

    const other = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
    await other.auth.signInWithPassword(stranger);
    const theirs = await recentRequests(other, project.id, modules);
    check("a stranger's turn is told nothing", theirs.length === 0);
  } finally {
    await project.remove();
    if (made?.user) await admin.auth.admin.deleteUser(made.user.id);
  }
}

console.log(
  fails.length === 0 ? "\nwhat their assistant asked for reaches Luke, and only the owner's" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
