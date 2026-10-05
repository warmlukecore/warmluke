// The tryout's browser walk, in the real sandbox (lib/walk.ts, 5 Oct): a
// returns section that works is walked at a laptop's width and a phone's
// with every step through, and one whose Reason filter has nothing to
// choose is caught, said as the person would meet it.
//
// By hand, never CI: it starts a Vercel Sandbox (the screen check's
// snapshot), so it needs SCREEN_SNAPSHOT_ID and sandbox credentials, and
// the walk page built (pnpm walk-page). Without them it says so and
// checks nothing.
//
//   (set -a; . ./.env.local; set +a; node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-walk.mjs)
//
// With CHECK_ENV=.env.check.local as well, a section is made on the check
// project and walked after its build as /api/apply walks it, the result
// read back off the build's line (never with CI running: one check database).

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canWalk, walkAfterBuild, walkBreaks, walkSection } from "../src/lib/walk.ts";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

if (!canWalk()) {
  console.log("the walk page, SCREEN_SNAPSHOT_ID and sandbox credentials are all needed; nothing checked");
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const is = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });
const returns = (reasons) => ({
  schema: {
    columns: [
      { field: "order", label: "Order", type: "link", linkTo: "m-orders" },
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "reason", label: "Reason", type: "dropdown" },
      { field: "status", label: "Status", type: "badge" },
      { field: "amount", label: "Amount", type: "currency" },
    ],
    features: {
      filters: [
        { field: "reason", label: "Reason", options: reasons },
        { field: "status", label: "Status", options: ["Requested", "Received"] },
      ],
      actions: [{ label: "Received", set: { status: { const: "Received" } }, when: is("status", "Requested") }],
      stats: [{ label: "Waiting", op: "count", where: is("status", "Requested") }],
    },
  },
  rows: [
    {
      id: "r1",
      data: { order: "o1", customer_name: "Asha", reason: reasons[0] ?? "", status: "Requested", amount: 900 },
    },
    {
      id: "r2",
      data: { order: "o2", customer_name: "Ravi", reason: reasons[1] ?? "", status: "Received", amount: 1200 },
    },
  ],
  links: {
    "m-orders": [
      { id: "o1", label: "#1042", data: { order_number: "#1042", customer_name: "Asha" } },
      { id: "o2", label: "#1043", data: { order_number: "#1043", customer_name: "Ravi" } },
    ],
  },
  targets: {
    "m-orders": {
      table: "orders",
      parents: {},
      columns: [
        { field: "order_number", label: "Order", type: "text" },
        { field: "customer_name", label: "Customer", type: "text" },
      ],
    },
  },
  locale: "en-IN",
  currency: "INR",
  timeZone: "Asia/Kolkata",
});

console.log("a section that works, walked at both widths");
{
  const t0 = Date.now();
  const walked = await walkSection(returns(["Size", "Damaged"]));
  console.log(`     (${Date.now() - t0}ms)`);
  check("walked at a laptop's width and a phone's", walked.map((w) => w.width).join() === "1440,390");
  check(
    "the filters, the sort, the button and the form, each tried",
    walked.every((w) => w.steps.length >= 5)
  );
  check("every step went through", walkBreaks(walked).length === 0);
  if (walkBreaks(walked).length) console.log(walkBreaks(walked));
  check(
    "and the page never broke",
    walked.every((w) => w.errors.length === 0)
  );
}

console.log("\none with a filter that offers nothing");
{
  const walked = await walkSection(returns([]));
  const broke = walkBreaks(walked);
  check(
    "caught, as the person would meet it",
    broke.some((b) => /Filter by Reason: it offers nothing to choose/.test(b))
  );
  console.log(`     ${broke.join("\n     ")}`);
}

if (process.env.CHECK_ENV) {
  console.log("\nafter a build, on the check project, as /api/apply walks it");
  const env = Object.fromEntries(
    readFileSync(process.env.CHECK_ENV, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
  );
  const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
  const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
  const owner = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
  const db = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${owner.session.access_token}` } },
  });
  const project = await throwawayProject(admin, owner.user.id, "walk");
  try {
    const { data: mod } = await admin
      .from("modules")
      .insert({
        project_id: project.id,
        name: "returns",
        nav_label: "Returns",
        icon: "table",
        route: "/modules/returns",
        sort_order: 1,
      })
      .select("id")
      .single();
    const input = returns(["Size", "Damaged"]);
    await admin.from("ui_schemas").insert({
      module_id: mod.id,
      version: 1,
      created_by: "ai",
      schema_json: { columns: input.schema.columns.filter((c) => c.type !== "link"), features: input.schema.features },
    });
    await admin
      .from("records")
      .insert(
        input.rows.map((r) => ({ project_id: project.id, module_id: mod.id, data: { ...r.data, order: undefined } }))
      );
    const { data: thread } = await admin
      .from("conversations")
      .insert({ project_id: project.id, title: "Returns" })
      .select("id")
      .single();
    const { data: line } = await admin
      .from("messages")
      .insert({
        conversation_id: thread.id,
        role: "assistant",
        content: "Returns.",
        payload: { type: "build", status: "built", message: "Returns." },
      })
      .select("id")
      .single();
    await walkAfterBuild(db, project.id, [{ changeType: "NEW_MODULE", moduleId: mod.id }], line.id);
    const { data: after } = await admin.from("messages").select("payload").eq("id", line.id).single();
    const walked = after.payload.walked;
    check("walked, and kept on the build's line", Array.isArray(walked) && walked[0]?.name === "Returns");
    check("with what was tried", walked?.[0]?.tried >= 8);
    check("and nothing broke", walked?.[0]?.breaks?.length === 0);
    if (walked?.[0]?.breaks?.length) console.log(walked[0].breaks);
    check("the line's own words kept", after.payload.message === "Returns." && after.payload.status === "built");
  } finally {
    await project.remove();
  }
}

console.log(fails.length === 0 ? "\nthe section is walked in a real browser" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
