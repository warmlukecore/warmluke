// How a section looks, changed without designing anything, both ways in
// (lib/view-edit.ts, 5 Oct): the owner's Customize, saved through
// /api/apply as their own version, and their AI's edit_view over MCP,
// which waits for the merchant's yes like any change, or builds at once
// with automatic builds on. No model is asked either way. What cannot be
// done comes back with why, and nothing is requested.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-edit-view.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { viewEditPlans } from "../src/lib/view-edit.ts";

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

const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const owner = await signInAsCheckUser(client, env);
if (!owner.session) {
  console.log(`could not sign in as the owner — ${owner.why}`);
  process.exit(1);
}
const token = owner.session.access_token;
const uid = owner.user.id;
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const project = await throwawayProject(admin, uid, "edit-view");
const runStartedAt = new Date().toISOString();

const post = async (path, body) => {
  const res = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
};
const tool = async (name, args) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};
const latest = async (moduleId) =>
  (
    await admin
      .from("ui_schemas")
      .select("version, created_by, schema_json, change_description")
      .eq("module_id", moduleId)
      .order("version", { ascending: false })
      .limit(1)
      .single()
  ).data;

try {
  await admin.from("projects").update({ auto_build: false }).eq("id", project.id);
  const made = await post("/api/apply", {
    projectId: project.id,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "returns", nav_label: "Returns", icon: "table" },
        newSchema: {
          columns: [
            { field: "order_no", label: "Order", type: "text" },
            { field: "customer", label: "Customer", type: "text" },
            { field: "status", label: "Status", type: "badge" },
            { field: "reason", label: "Reason", type: "dropdown" },
            { field: "amount", label: "Amount", type: "currency" },
          ],
        },
        features: { filters: [{ field: "status", label: "Status", options: ["Requested", "Received", "Refunded"] }] },
        newRecords: [
          { order_no: "#1", customer: "Asha", status: "Requested", reason: "Size", amount: 900 },
          { order_no: "#2", customer: "Ravi", status: "Received", reason: "Damaged", amount: 1200 },
        ],
        explanation: "Returns to log.",
      },
    ],
  });
  check("a section to change", made.ok);
  const { data: mod } = await admin
    .from("modules")
    .select("id")
    .eq("project_id", project.id)
    .eq("name", "returns")
    .single();
  const before = await latest(mod.id);

  console.log("\nthe owner's Customize");
  {
    const { plans } = viewEditPlans(
      mod.id,
      before.schema_json,
      { columns: [{ field: "customer", label: "Buyer" }], sort: { field: "amount", dir: "desc" } },
      () => []
    );
    const saved = await post("/api/apply", { projectId: project.id, plans, by: "user" });
    check("saved, with no model asked", saved.ok && saved.data.applied === true);
    const now = await latest(mod.id);
    check("a version of its own, by the owner", now.created_by === "user" && now.version > before.version);
    const buyer = now.schema_json.columns.find((c) => c.field === "customer");
    check("renamed, and marked as theirs", buyer.label === "Buyer" && buyer.named === true);
    check("the order rows open in", now.schema_json.features.defaultSort?.field === "amount");
    check("said in History in words", /renamed "Customer" to "Buyer"/i.test(now.change_description ?? ""));
  }

  console.log("\ntheir AI's edit_view");
  {
    const asked = await tool("edit_view", {
      section: "Returns",
      columns: [{ field: "amount", hidden: true }],
      filters: ["status", "reason"],
      request: "amount table se hatao aur reason ka filter do",
    });
    check("it waits for the merchant's yes", asked?.status === "waiting for approval" && !!asked?.request_id);
    const still = await latest(mod.id);
    check("and nothing has changed yet", !still.schema_json.columns.find((c) => c.field === "amount").hidden);

    await admin.from("projects").update({ auto_build: true }).eq("id", project.id);
    const built = await tool("edit_view", { section: "returns", filters: ["status", "reason"] });
    check("with automatic builds on, built at once", built?.status === "built");
    const now = await latest(mod.id);
    const reason = now.schema_json.features.filters?.find((f) => f.field === "reason");
    check("a filter from what the rows hold", reason?.options?.join() === "Size,Damaged");
    check("the status filter as it was", now.schema_json.features.filters?.[0]?.options?.length === 3);
  }

  const requests = async () =>
    (await admin.from("build_requests").select("id", { count: "exact", head: true }).eq("project_id", project.id))
      .count;

  console.log("\nwhat cannot be done is said, and nothing is requested");
  {
    const was = await requests();
    const money = await tool("edit_view", { section: "Returns", filters: ["amount"] });
    check(
      "money is no filter, with why",
      money?.status === "not accepted" && /not a column of choices/.test(money.errors?.join())
    );
    const nope = await tool("edit_view", { section: "Returns", columns: [{ field: "nope" }] });
    check("a column that is not there", nope?.status === "not accepted");
    const same = await tool("edit_view", { section: "Returns", filters: ["status", "reason"] });
    check("nothing to change", same?.status === "nothing to change");
    check(
      "no section: asked which, before anything is read",
      /Which section/.test((await tool("edit_view", {}))?.error)
    );
    check(
      "columns in the wrong shape: said so",
      /not in the shape/.test((await tool("edit_view", { section: "Returns", columns: "amount" }))?.error)
    );
    const lost = await tool("edit_view", { section: "Nowhere" });
    check(
      "a section that is not there names the ones that are",
      Array.isArray(lost?.sections) && lost.sections.includes("Returns")
    );
    check("and not one request was made", (await requests()) === was);
  }

  // Seeing it a certain way, or a row to put in (lib/screen.ts, #3): a
  // link that opens the section so, read by the code Luke's answers go
  // through; nothing requested, changed or written.
  console.log("\ntheir AI's show_on_screen");
  {
    const was = await requests();
    const version = (await latest(mod.id)).version;
    const rows = async () =>
      (await admin.from("records").select("id", { count: "exact", head: true }).eq("module_id", mod.id)).count;
    const rowsWere = await rows();
    const shown = await tool("show_on_screen", {
      section: "Returns",
      filters: { Status: "received", courier: "Delhivery" },
      add: { customer: "Neha", amount: "₹700" },
    });
    const url = shown?.link ? new URL(shown.link) : null;
    check(
      "a link to the section",
      url?.pathname === `/app/${project.id}` && url?.searchParams.get("section") === mod.id
    );
    const show = JSON.parse(url?.searchParams.get("show") ?? "{}");
    check("held to its own filters, spelled as they offer them", show.filters?.status === "Received");
    check("a row filled as its form holds it", show.add?.customer === "Neha" && show.add?.amount === 700);
    check("what it does not have, said", shown?.not_done?.includes("Returns has no courier filter"));
    check("said in words", (shown?.shows ?? "").startsWith("Returns: Status: Received; a new row in Returns, "));
    check("nothing saved till they press Add row", /Add row/.test(shown?.note ?? ""));
    check(
      "nothing asked: said so",
      /Nothing asked/.test((await tool("show_on_screen", { section: "Returns" }))?.error ?? "")
    );
    check("no section: asked which", /Which section/.test((await tool("show_on_screen", {}))?.error ?? ""));
    check("no request made, no version", (await requests()) === was && (await latest(mod.id)).version === version);
    check("and no row written", (await rows()) === rowsWere);
  }
} finally {
  await admin.from("mcp_calls").delete().eq("user_id", uid).gte("created_at", runStartedAt);
  await project.remove();
}

console.log(
  fails.length === 0
    ? "\na section's look changes without a design, both ways in, and is shown as asked"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
