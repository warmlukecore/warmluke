// The last two of what the import already holds are lists too.
//
// Seven tables come in from Shopify; refunds and variants had no list,
// and a list that does not exist cannot be built over. Now they read
// like every other store list — through the same function, with their
// order's number and customer, their product's title — and a section
// can be built over each through the one door.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-refunds-and-variants.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { readStoreRows, STORE_TABLES } from "../src/lib/store-read.ts";

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
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};

console.log("declared once");
check("refunds are a list", STORE_TABLES.refunds?.view === "store_refunds");
check("and so are variants", STORE_TABLES.variants?.view === "store_variants");

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "refunds-variants");
const stamp = Date.now().toString(36);

try {
  const store = must(
    await admin
      .from("stores")
      .insert({
        project_id: project.id,
        shop_domain: `rv-${stamp}.myshopify.com`,
        status: "connected",
        currency: "INR",
        timezone: "Asia/Kolkata",
      })
      .select("id")
      .single()
  );
  const [aman] = must(
    await admin
      .from("customers")
      .insert([{ store_id: store.id, external_id: `c-${stamp}`, name: "Aman Kumar" }])
      .select("id")
  );
  const order = must(
    await admin
      .from("orders")
      .insert({
        store_id: store.id,
        external_id: `o-${stamp}`,
        order_number: "#1001",
        placed_at: new Date().toISOString(),
        total: 2598,
        currency: "INR",
        financial_status: "PAID",
        customer_id: aman.id,
        tags: [],
      })
      .select("id")
      .single()
  );
  must(
    await admin.from("refunds").insert({
      store_id: store.id,
      order_id: order.id,
      external_id: `r-${stamp}`,
      amount: 299,
      quantity: 1,
      refunded_at: new Date().toISOString(),
    })
  );
  const product = must(
    await admin
      .from("products")
      .insert({
        store_id: store.id,
        external_id: `p-${stamp}`,
        title: "Boat Airdopes 141",
        handle: `airdopes-${stamp}`,
        status: "ACTIVE",
      })
      .select("id")
      .single()
  );
  must(
    await admin.from("variants").insert([
      {
        store_id: store.id,
        product_id: product.id,
        external_id: `v-${stamp}-1`,
        title: "Black",
        sku: "BA141-BLK",
        barcode: "8901234567890",
        price: 1299,
      },
      {
        store_id: store.id,
        product_id: product.id,
        external_id: `v-${stamp}-2`,
        title: "Blue",
        sku: "BA141-BLU",
        price: 1299,
      },
    ])
  );

  console.log("\nrefunds, read like any other list");
  const refunds = await readStoreRows(admin, store.id, "refunds", 50);
  const r = refunds.rows[0]?.data;
  check(
    "one row per refund, with its order and customer",
    refunds.total === 1 && r?.order_number === "#1001" && r?.customer_name === "Aman Kumar"
  );
  check(
    "the amount in the order's currency, on a day",
    Number(r?.amount) === 299 && r?.currency === "INR" && /^\d{4}-\d{2}-\d{2}$/.test(r?.refunded_at)
  );
  const byOrder = await readStoreRows(admin, store.id, "refunds", 50, "#1001");
  check("searchable by order number", byOrder.rows.length === 1);

  console.log("\nvariants, read like any other list");
  const variants = await readStoreRows(admin, store.id, "variants", 50);
  check(
    "one row per variant, with its product's title",
    variants.total === 2 && variants.rows.every((v) => v.data.product === "Boat Airdopes 141")
  );
  const blk = variants.rows.find((v) => v.data.sku === "BA141-BLK")?.data;
  check(
    "SKU, barcode and price, in the shop's currency",
    blk?.barcode === "8901234567890" && Number(blk?.price) === 1299 && blk?.currency === "INR"
  );
  const bySku = await readStoreRows(admin, store.id, "variants", 50, "BA141-BLU");
  check("searchable by SKU", bySku.rows.length === 1 && bySku.rows[0].data.variant === "Blue");

  console.log("\nand sections over them, through the one door");
  for (const table of ["refunds", "variants"]) {
    const spec = STORE_TABLES[table];
    const built = await client.rpc("abo_build", {
      p_project: project.id,
      p_request: null,
      p_op: "module_insert",
      p_payload: {
        name: table,
        nav_label: spec.section.label,
        route: `/modules/${table}`,
        source_table: table,
        icon: spec.section.icon,
      },
    });
    check(`the owner can build a ${spec.section.label} section`, !built.error && !!built.data?.id);
    if (built.error) console.log("     →", built.error.message);
  }
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\neverything the import brings is a list" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
