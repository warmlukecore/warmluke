// The Luke eval's graders on real rows, with no model and no server.
//
// check-eval-harness proves the graders on rows it makes up. What it cannot
// prove is the road real rows take: that every business shop saves through
// the import's own savers, that a section over the store reads back with the
// owner's fields laid under the store's (lib/dry-run readSection, on the
// owner's client, under RLS), that the store's own fields are told apart,
// and that a counter is worked out as the screen shows it. So each shop is
// seeded into a throwaway project, and a right and a wrong "build" are
// written in as a design would leave them; the eval's own reader and grader
// must pass the right one and fail the wrong one.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-eval-graders.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedBusiness, shopNodes, variantsOf } from "./fixtures/business-shop.ts";
import { SHOPS } from "./fixtures/shops.ts";
import { EXPECT, viewOf } from "../evals/expect.mjs";
import { appSections, effectCheck } from "./eval-luke.mjs";
import { readSection, sectionFor } from "../src/lib/dry-run.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";
import { evalExpr, truthy } from "../src/lib/expr.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.check.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const owner = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const fails = [];
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) {
    fails.push(name);
    if (detail) console.log("     →", detail);
  }
};

const me = await signInAsCheckUser(owner, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const stamp = Date.now().toString(36);
const NOW = Date.now();

async function shopProject(name) {
  const project = await throwawayProject(admin, me.user.id, `check eval ${name}`);
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `eval-${name}-${stamp}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make ${name}'s store: ${error.message}`);
  await seedBusiness(admin, store.id, SHOPS[name], NOW);
  return { project, store };
}

async function section(projectId, label, source_table, schema) {
  const { data: mod, error } = await admin
    .from("modules")
    .insert({
      project_id: projectId,
      name: `${label.toLowerCase()}-${stamp}`,
      nav_label: label,
      route: `/${label.toLowerCase()}-${stamp}`,
      source_table,
    })
    .select("*")
    .single();
  if (error) throw new Error(`could not make ${label}: ${error.message}`);
  await admin.from("ui_schemas").insert({ module_id: mod.id, version: 1, schema_json: schema });
  return mod;
}

const appOf = async (projectId, mods) => {
  const schemas = new Map();
  for (const m of mods) {
    const { data } = await admin
      .from("ui_schemas")
      .select("schema_json")
      .eq("module_id", m.id)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    schemas.set(m.id, data.schema_json);
  }
  const ctx = {
    db: owner,
    projectId,
    store: null,
    modules: mods,
    schemas,
    ownerWords: "",
    understood: "",
    locale: "en-IN",
    currency: "INR",
    uxModel: null,
  };
  return appSections(ctx, mods, schemas, { sectionFor, readSection, STORE_TABLES, evalExpr, truthy });
};

const made = [];
try {
  console.log("every shop saves through the import's own savers");
  const projects = {};
  for (const name of Object.keys(SHOPS)) {
    const p = await shopProject(name);
    made.push(p.project);
    projects[name] = p;
    const { count: orders } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", p.store.id);
    const { count: variants } = await admin
      .from("variants")
      .select("id", { count: "exact", head: true })
      .eq("store_id", p.store.id);
    check(
      `${name}: its ${SHOPS[name].orders.length} orders and ${variantsOf(SHOPS[name]).length} variants`,
      orders === SHOPS[name].orders.length && variants === variantsOf(SHOPS[name]).length,
      { orders, variants }
    );
  }

  console.log("\nthe rows a build points at, read as the owner's screen reads them");
  const snacks = projects.snacks;
  const repeat = EXPECT["snacks-repeat-cod"](viewOf(shopNodes(SHOPS.snacks, NOW), NOW)).effect;
  const orders = await section(snacks.project.id, "Orders", "orders", {
    columns: [{ field: "repeat_cod", label: "Repeat COD", type: "boolean" }],
    features: {
      stats: [
        { label: "Repeat COD", op: "count", where: { op: "=", args: [{ field: "repeat_cod" }, { const: true }] } },
      ],
    },
  });
  const { data: rows } = await admin
    .from("store_orders")
    .select("id, order_number, gateway")
    .eq("store_id", snacks.store.id);
  const tick = async (ids) => {
    await admin.from("records").delete().eq("module_id", orders.id);
    if (ids.length)
      await admin.from("records").insert(
        ids.map((id) => ({
          project_id: snacks.project.id,
          module_id: orders.id,
          store_row_id: id,
          data: { repeat_cod: true },
        }))
      );
  };
  await tick(rows.filter((r) => repeat.labels.includes(r.order_number)).map((r) => r.id));
  let app = await appOf(snacks.project.id, [orders]);
  const read = app.find((s) => s.name === "Orders");
  check("the section reads back with every order", read?.rows.length === SHOPS.snacks.orders.length, read?.rows.length);
  check(
    "the store's fields are told apart from the owner's",
    read?.storeFields.has("order_number") && !read.storeFields.has("repeat_cod")
  );
  check("the counter is worked out over the rows", read?.stats[0]?.value === repeat.count, read?.stats);
  const right = effectCheck(app, repeat);
  check("a tick on exactly the repeat COD orders passes", right.ok, right.detail);
  await tick(rows.filter((r) => /cod/i.test(r.gateway ?? "")).map((r) => r.id));
  app = await appOf(snacks.project.id, [orders]);
  const wrong = effectCheck(
    app.map((s) => ({ ...s, stats: [] })),
    repeat
  );
  check("a tick on every COD order fails", !wrong.ok, wrong.detail);

  console.log("\nrows of the owner's own section");
  const cosmetics = projects.cosmetics;
  const soon = EXPECT["cosmetics-expiring"]().effect;
  const batches = await section(cosmetics.project.id, "Batches", null, {
    columns: [
      { field: "batch_code", label: "Batch", type: "text" },
      { field: "expiring", label: "Expiring soon", type: "boolean" },
    ],
  });
  await admin.from("records").insert(
    ["VCS-2401", "HYA-2402", "SPF-2403"].map((b) => ({
      project_id: cosmetics.project.id,
      module_id: batches.id,
      data: { batch_code: b, expiring: soon.labels.includes(b) },
    }))
  );
  const own = effectCheck(await appOf(cosmetics.project.id, [batches]), soon);
  check("found by the section's name, marked by the owner's tick", own.ok, own.detail);
} finally {
  for (const p of made) await p.remove();
}

console.log(fails.length === 0 ? "\nthe eval's graders read real rows as the screen does" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
