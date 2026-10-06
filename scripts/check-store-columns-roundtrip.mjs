// Hidden, edited round, shown again (0192): an administrator hides two of
// an account's order columns; the owner edits the section in Customize and
// a design adds a card, each seeing only what is shown, through the same
// save route the app and Luke use. Shown again, the section has everything
// it had (the filter, the card and the button over a hidden column, the
// name the owner gave one) and both edits. Nothing a merchant built is lost
// by a column being hidden.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-columns-roundtrip.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";
import { hiddenColumns, readShownFrom, storeSectionColumns, withoutHidden } from "../src/lib/store-read.ts";
import { viewEditPlans } from "../src/lib/view-edit.ts";

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

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const apply = async (body) => {
  const r = await fetch(`${APP}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${me.session.access_token}` },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
};
const latest = async (id) =>
  (
    await admin
      .from("ui_schemas")
      .select("schema_json, version")
      .eq("module_id", id)
      .order("version", { ascending: false })
      .limit(1)
      .single()
  ).data;

const project = await throwawayProject(admin, me.user.id, "store columns round trip");
const COD = { op: "=", args: [{ field: "gateway" }, { const: "Cash on Delivery (COD)" }] };
const SHOWN = ["order_number", "placed_at", "customer_name", "total", "status", "fulfilment_status"];
// What each filter offers, as Customize reads it off the list.
const VALUES = { status: ["Paid", "Payment pending"], gateway: ["Cash on Delivery (COD)", "razorpay"] };
const valuesOf = (field) => VALUES[field] ?? [];

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `roundtrip-${project.id.slice(0, 8)}.myshopify.com`,
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

  console.log("a section built with every column");
  const made = await apply({
    projectId: project.id,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "rt-orders", nav_label: "Calling", icon: "table", source_table: "orders" },
        newSchema: { columns: [{ field: "called", label: "Called", type: "boolean" }] },
        features: {
          filters: [
            { field: "status", label: "Status", options: VALUES.status },
            { field: "gateway", label: "Paid by", options: VALUES.gateway },
          ],
          stats: [
            { label: "Gross", op: "sum", value: { field: "total" } },
            { label: "COD orders", op: "count", where: COD },
          ],
          actions: [{ label: "Mark called", set: { called: { const: true } }, when: COD }],
        },
        newRecords: null,
        explanation: "Orders to call.",
      },
    ],
  });
  check("built", made.ok || console.log("   ", JSON.stringify(made.data).slice(0, 300)));
  const { data: mod } = await admin
    .from("modules")
    .select("id")
    .eq("project_id", project.id)
    .eq("name", "rt-orders")
    .single();
  const id = mod.id;
  // The owner names the phone column their way, before anything is hidden.
  const first = (await latest(id)).schema_json;
  const named = viewEditPlans(
    id,
    { ...first, columns: storeSectionColumns("orders", first.columns) },
    { columns: [{ field: "customer_phone", label: "Mobile" }] },
    valuesOf
  );
  check('the owner names Phone "Mobile"', (await apply({ projectId: project.id, plans: named.plans, by: "user" })).ok);
  const before = await latest(id);

  console.log("\nphone and payment hidden for the account; the section edited round them");
  await admin.from("account_store_columns").upsert({ user_id: me.user.id, store_table: "orders", shown: SHOWN });
  // What the app shows the owner, worked out as the app does.
  readShownFrom(() => ({ shown: { orders: SHOWN }, strip: false }));
  const sj = before.schema_json;
  const seen = {
    columns: storeSectionColumns("orders", sj.columns),
    features: withoutHidden(sj.features, hiddenColumns("orders")),
  };
  readShownFrom(() => undefined);
  if (process.env.SHOW)
    console.log(
      "   saved filters:",
      JSON.stringify(sj.features.filters),
      "seen filters:",
      JSON.stringify(seen.features.filters),
      "seen stats:",
      seen.features.stats.length,
      "mobile:",
      seen.columns.some((c) => c.field === "customer_phone")
    );
  check(
    "the owner sees no Mobile, no Paid by filter, no COD card",
    !seen.columns.some((c) => c.field === "customer_phone") &&
      seen.features.filters.length === 1 &&
      seen.features.stats.length === 1
  );
  const custom = viewEditPlans(
    id,
    seen,
    { columns: [{ field: "order_number", label: "Order no" }], filters: [] },
    valuesOf
  );
  const ownerSave = await apply({ projectId: project.id, plans: custom.plans, by: "user" });
  check(
    "Customize saves: Order renamed, the Status filter taken off",
    ownerSave.ok || console.log("   ", JSON.stringify(ownerSave.data).slice(0, 300))
  );
  const design = await apply({
    projectId: project.id,
    plans: [
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: id,
        features: { stats: [...seen.features.stats, { label: "Orders", op: "count" }] },
        explanation: "A count of the orders.",
      },
    ],
  });
  check(
    "a design adds a card, sending the cards it sees",
    design.ok || console.log("   ", JSON.stringify(design.data).slice(0, 300))
  );

  console.log("\nshown again");
  await admin.from("account_store_columns").delete().eq("user_id", me.user.id);
  const after = (await latest(id)).schema_json;
  const cols = storeSectionColumns("orders", after.columns);
  if (process.env.SHOW) console.log("   after filters:", JSON.stringify(after.features.filters));
  // Customize keeps a filter taken off the bar, off it (hidden), as it always has.
  check(
    "the Paid by filter is back on the bar; the Status filter the owner took off stays off",
    JSON.stringify(after.features.filters.filter((f) => !f.hidden).map((f) => f.field)) === '["gateway"]' &&
      after.features.filters.find((f) => f.field === "status")?.hidden === true
  );
  check(
    "the COD card is there, beside Gross and the new one",
    after.features.stats.map((s) => s.label).join() === "Gross,Orders,COD orders"
  );
  check("the button over how it was paid is there", after.features.actions?.[0]?.label === "Mark called");
  check("Phone keeps the owner's name, Mobile", cols.find((c) => c.field === "customer_phone")?.label === "Mobile");
  check("and the owner's rename stands", cols.find((c) => c.field === "order_number")?.label === "Order no");
  check(
    "and Mobile stands where it stood",
    cols.findIndex((c) => c.field === "customer_phone") ===
      storeSectionColumns("orders", sj.columns).findIndex((c) => c.field === "customer_phone")
  );
} finally {
  await admin.from("account_store_columns").delete().eq("user_id", me.user.id);
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nnothing a merchant built is lost by a column being hidden");
process.exit(fails.length ? 1 : 0);
