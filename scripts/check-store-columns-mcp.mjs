// Their own AI is shown the store's lists as the account is (0192): with
// Orders narrowed, read_section's columns and rows, design_format's lists
// and search_store's rows leave out what the account is not shown, and
// design_format says some are not shown. Driven as a client would.
//
//   ENV_FILE=.env.check.local APP_URL=http://127.0.0.1:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-columns-mcp.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") throw new Error("not the check project's env; this writes");
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
let n = 0;
const call = (name, args, token) =>
  fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
  })
    .then((r) => r.json())
    .then((j) => {
      try {
        return JSON.parse(j.result.content[0].text);
      } catch {
        return { unread: j };
      }
    });

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const token = me.session.access_token;
const project = await throwawayProject(admin, me.user.id, "store columns mcp");
const SHOWN = ["order_number", "placed_at", "customer_name", "total", "status"];
const HIDDEN = ["customer_phone", "ship_city", "discount_codes"];
const has = (v, f) => JSON.stringify(v).includes(`"${f}"`);

try {
  const domain = `cols-mcp-${project.id.slice(0, 8)}.myshopify.com`;
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: domain,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const { data: mod } = await admin
    .from("modules")
    .insert({
      project_id: project.id,
      name: "cols-orders",
      nav_label: "Orders here",
      icon: "table",
      route: "/cols-orders",
      source_table: "orders",
    })
    .select("id")
    .single();
  await admin
    .from("ui_schemas")
    .insert({ module_id: mod.id, schema_json: { columns: [] }, version: 1, created_by: "user" });

  const read = () => call("read_section", { section: "Orders here", project_id: project.id }, token);
  const format = () => call("design_format", { project_id: project.id }, token);
  const search = () => call("search_store", { table: "orders", shop_domain: domain }, token);

  console.log("every column");
  const whole = await read();
  check(
    "read_section reads the orders' columns",
    HIDDEN.every((f) => has(whole, f))
  );

  console.log("\nOrders narrowed");
  const { error: setErr } = await admin
    .from("account_store_columns")
    .insert({ user_id: me.user.id, store_table: "orders", shown: SHOWN });
  if (setErr) throw new Error(`could not narrow: ${setErr.message}`);
  const narrowed = await read();
  check(
    "read_section names none it is not shown",
    HIDDEN.every((f) => !has(narrowed, f))
  );
  check(
    "and keeps the ones it is",
    SHOWN.every((f) => has(narrowed, f))
  );
  const brief = await format();
  check(
    "design_format's orders are the ones shown",
    JSON.stringify(brief.store_columns?.orders ?? []) === JSON.stringify(SHOWN)
  );
  check(
    "and it says some are not shown",
    /only some of the store's columns on: orders/.test(brief.store_columns_not_shown ?? "")
  );
  check(
    "its advice names none it is not shown",
    HIDDEN.every((f) => !JSON.stringify(brief.store_advice ?? {}).includes(f))
  );
  const found = await search();
  check("search_store's rows leave them out", found?.rows?.length > 0 && HIDDEN.every((f) => !has(found, f)));
} finally {
  await admin.from("account_store_columns").delete().eq("user_id", me.user.id);
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\ntheir own AI reads the store as the account is shown it");
process.exit(fails.length ? 1 : 0);
