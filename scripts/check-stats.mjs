// A stat is over the section, not the page.
//
// Two hundred and fifty rows in a section of the merchant's own, and a
// page of two hundred: the card has to say 250, and add up all 250.
// Then the same numbers worked out the browser's old way over the same
// rows, to prove the two halves of the expression engine still agree.
// Then grouping, a filter, a search, a computed column, a time window,
// somebody else's section, and a store section whose shape now comes
// from a view.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-stats.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { evalExpr, truthy } from "../src/lib/expr.ts";
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
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "stats");
const stamp = Date.now().toString(36);
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};
const stats = async (moduleId, list, scope = {}) => {
  const { data, error } = await client.rpc("abo_section_stats", { p_module: moduleId, p_stats: list, p_scope: scope });
  if (error) throw new Error(error.message);
  return data;
};
const close = (a, b) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 0.005;

try {
  // ── A section of their own, bigger than a page ───────────────
  const columns = [
    { field: "city", label: "City", type: "text" },
    { field: "amount", label: "Amount", type: "currency" },
    { field: "qty", label: "Qty", type: "number" },
    { field: "placed", label: "Placed", type: "date" },
    { field: "status", label: "Status", type: "badge" },
    {
      field: "line",
      label: "Line",
      type: "number",
      compute: { op: "*", args: [{ field: "qty" }, { field: "amount" }] },
    },
  ];
  const mod = must(
    await admin
      .from("modules")
      .insert({
        project_id: project.id,
        name: `stats-${stamp}`,
        nav_label: `Stats ${stamp}`,
        icon: "table",
        route: `/modules/stats-${stamp}`,
        sort_order: 1,
      })
      .select("id")
      .single()
  );
  must(
    await admin.from("ui_schemas").insert({
      module_id: mod.id,
      schema_json: { columns },
      version: 1,
      created_by: "user",
      change_description: "check",
    })
  );
  const today = new Date();
  const day = (k) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - k)).toISOString().slice(0, 10);
  const cities = ["Mumbai", "Delhi", "Pune", ""];
  const rows = Array.from({ length: 250 }, (_, i) => ({
    city: cities[i % 4],
    amount: i,
    qty: 2,
    placed: day(i % 60),
    status: i % 3 ? "Paid" : "Pending",
  }));
  for (let i = 0; i < rows.length; i += 100) {
    must(await admin.from("records").insert(rows.slice(i, i + 100).map((data) => ({ module_id: mod.id, data }))));
  }
  const computed = columns.filter((c) => c.compute).map((c) => ({ field: c.field, expr: c.compute }));
  const withComputed = rows.map((r) => ({ data: { ...r, line: r.qty * r.amount } }));
  const local = (s, rs) => {
    const matched = s.where ? rs.filter((r) => truthy(evalExpr(s.where, r.data))) : rs;
    if (s.op === "count") return matched.length;
    const expr = s.value ?? { field: s.field };
    const nums = matched.map((r) => Number(evalExpr(expr, r.data))).filter((n) => !Number.isNaN(n));
    const total = nums.reduce((a, b) => a + b, 0);
    return s.op === "sum"
      ? total
      : s.op === "avg"
        ? total / nums.length
        : s.op === "min"
          ? Math.min(...nums)
          : Math.max(...nums);
  };
  const plain = [
    { label: "Rows", op: "count" },
    { label: "Amount", op: "sum", field: "amount" },
    { label: "Average", op: "avg", value: { field: "amount" } },
    { label: "Biggest", op: "max", field: "amount" },
    { label: "Paid", op: "count", where: { op: "=", args: [{ field: "status" }, { const: "Paid" }] } },
    { label: "Line total", op: "sum", field: "line" },
    {
      label: "Last 30 days",
      op: "count",
      where: { op: "<=", args: [{ op: "days_since", args: [{ field: "placed" }] }, { const: 30 }] },
    },
  ];

  console.log("a section of 250 rows, and a page of 200");
  const page = must(await admin.from("records").select("id").eq("module_id", mod.id).limit(200));
  check("the page really is smaller than the section", page.length === 200);
  const out = await stats(mod.id, plain, { computed });
  check("the card counts every row, not the page", out[0]?.count === 250 && Number(out[0]?.value) === 250);
  check("and adds up every row", Number(out[1]?.value) === local(plain[1], withComputed));
  check("average, over all of them", close(out[2]?.value, local(plain[2], withComputed)));
  check("the biggest is the last row", Number(out[3]?.value) === 249);
  check(
    "a where narrows it",
    out[4]?.count === local(plain[4], withComputed) && out[4]?.count > 0 && out[4]?.count < 250
  );
  check("a computed column is worked out on the way", Number(out[5]?.value) === local(plain[5], withComputed));
  // The two halves read "today" from their own clocks; a row placed
  // exactly 30 days ago can fall either side near midnight.
  check(
    "a time window works, and agrees with the browser's arithmetic",
    Math.abs(out[6]?.count - local(plain[6], withComputed)) <= 5
  );
  if (fails.length) show(out);

  console.log("\nwhat the person is looking at still narrows the numbers");
  const filtered = await stats(mod.id, [plain[0], plain[1]], { computed, filters: { status: "paid" } });
  const paid = withComputed.filter((r) => r.data.status === "Paid");
  check("a filter, spelled without its capital", filtered[0]?.count === paid.length);
  check("and the sum follows it", Number(filtered[1]?.value) === paid.reduce((a, r) => a + r.data.amount, 0));
  const searched = await stats(mod.id, [plain[0]], { computed, search: "mumb", search_fields: ["city"] });
  check(
    "a search, on the fields the section searches",
    searched[0]?.count === withComputed.filter((r) => r.data.city === "Mumbai").length
  );
  const both = await stats(mod.id, [plain[0]], {
    computed,
    search: "mumb",
    search_fields: ["city"],
    filters: { status: "Paid" },
  });
  check("and both together", both[0]?.count === paid.filter((r) => r.data.city === "Mumbai").length);

  console.log("\ngrouped: sales by city");
  const grouped = await stats(
    mod.id,
    [
      { label: "By city", op: "sum", field: "amount", by: "city", limit: 3 },
      { label: "Orders per status", op: "count", by: "status" },
      { label: "Biggest by city", op: "max", field: "amount", by: "city", limit: 20 },
    ],
    { computed }
  );
  const byCity = {};
  for (const r of withComputed) byCity[r.data.city] = (byCity[r.data.city] ?? 0) + r.data.amount;
  const topCities = Object.entries(byCity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  check(
    "the top three, biggest first",
    JSON.stringify(grouped[0]?.groups?.map((g) => [g.key, Number(g.value)])) === JSON.stringify(topCities)
  );
  check(
    "a count per group",
    grouped[1]?.groups?.find((g) => g.key === "Paid")?.count === paid.length && grouped[1]?.groups?.length === 2
  );
  check(
    "a blank value is its own group, not dropped",
    grouped[2]?.groups?.some((g) => g.key === "") && grouped[2]?.groups?.length === 4
  );
  check("the whole count still comes along", grouped[0]?.count === 250);
  if (fails.length) show(grouped);

  console.log("\nthe list of store lists, in both languages");
  // TypeScript declares the lists (STORE_TABLES); SQL guards the same
  // list (abo_is_store_table, 0085). Two languages, one list each — a
  // sixth table added to one and not the other fails here, not on a
  // merchant's insert.
  for (const [t, spec] of Object.entries(STORE_TABLES)) {
    const { data: known } = await admin.rpc("abo_is_store_table", { t });
    check(`"${t}" is a store table to the database too`, known === true);
    // And the view that holds it is the same view in both languages:
    // the stats function reads whichever the database names.
    const { data: view } = await admin.rpc("abo_store_view", { t });
    check(`  and its view is ${spec.view} to both`, view === spec.view);
  }
  const { data: stranger } = await admin.rpc("abo_is_store_table", { t: "not_a_table" });
  check("and a name that is not one is not", stranger === false);

  console.log("\nsomebody else's section");
  const { data: other, error: userErr } = await admin.auth.admin.createUser({
    email: `stats-other-${stamp}@warmluke.test`,
    password: `pw-${stamp}-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (userErr) throw new Error(userErr.message);
  const theirProject = await throwawayProject(admin, other.user.id, "stats-other");
  try {
    const theirs = must(
      await admin
        .from("modules")
        .insert({
          project_id: theirProject.id,
          name: `theirs-${stamp}`,
          nav_label: "Theirs",
          icon: "table",
          route: `/modules/theirs-${stamp}`,
          sort_order: 1,
        })
        .select("id")
        .single()
    );
    const { error: refused } = await client.rpc("abo_section_stats", {
      p_module: theirs.id,
      p_stats: [plain[0]],
      p_scope: {},
    });
    check("is refused, not counted", !!refused && /No such section/.test(refused.message));
  } finally {
    await theirProject.remove();
    await admin.auth.admin.deleteUser(other.user.id);
  }

  // ── A store section: the shape comes from a view now ─────────
  console.log("\na store section, in the shape the app shows");
  const store = must(
    await admin
      .from("stores")
      .insert({
        project_id: project.id,
        shop_domain: `stats-${stamp}.myshopify.com`,
        status: "connected",
        currency: "INR",
      })
      .select("id")
      .single()
  );
  const [ann, zed] = must(
    await admin
      .from("customers")
      .insert([
        { store_id: store.id, external_id: `c-${stamp}-1`, name: "Ann", orders_count: 1 },
        { store_id: store.id, external_id: `c-${stamp}-2`, name: "Zed", orders_count: 2 },
      ])
      .select("id, name")
  );
  must(
    await admin.from("orders").insert([
      {
        store_id: store.id,
        external_id: `o-${stamp}-1`,
        order_number: "#1",
        placed_at: "2026-09-01T10:00:00Z",
        total: 100,
        currency: "INR",
        financial_status: "PAID",
        customer_id: ann.id,
        tags: ["gift", "rush"],
      },
      {
        store_id: store.id,
        external_id: `o-${stamp}-2`,
        order_number: "#2",
        placed_at: "2026-09-02T10:00:00Z",
        total: 250,
        currency: "INR",
        financial_status: "PAID",
        customer_id: zed.id,
        tags: [],
      },
      {
        store_id: store.id,
        external_id: `o-${stamp}-3`,
        order_number: "#3",
        placed_at: "2026-09-03T10:00:00Z",
        total: 400,
        currency: "INR",
        financial_status: "PAID",
        cancelled_at: "2026-09-04T00:00:00Z",
        customer_id: zed.id,
        tags: [],
      },
    ])
  );
  const read = await readStoreRows(admin, store.id, "orders", 10);
  const byNo = (n) => read.rows.find((r) => r.data.order_number === n)?.data;
  check(
    "a cancelled order reads as Cancelled, whatever it was paid",
    byNo("#3")?.status === "Cancelled" && byNo("#2")?.status === "PAID"
  );
  check(
    "the customer's name sits beside the order",
    byNo("#1")?.customer_name === "Ann" && byNo("#2")?.customer_name === "Zed"
  );
  check("the day, not the timestamp", byNo("#1")?.placed_at === "2026-09-01");
  check("tags read as one cell", byNo("#1")?.tags === "gift, rush");
  const lastName = await readStoreRows(admin, store.id, "orders", 1, undefined, {
    field: "customer_name",
    dir: "desc",
  });
  check("and a joined column can be sorted on, on the server", lastName.rows[0]?.data.customer_name === "Zed");
  const found = await readStoreRows(admin, store.id, "orders", 10, "ann");
  check("and searched by", found.rows.length === 1 && found.rows[0].data.order_number === "#1");

  const smod = must(
    await admin
      .from("modules")
      .insert({
        project_id: project.id,
        name: `orders-${stamp}`,
        nav_label: "Orders",
        icon: "table",
        route: `/modules/orders-${stamp}`,
        sort_order: 2,
        source_table: "orders",
      })
      .select("id")
      .single()
  );
  const sout = await stats(
    smod.id,
    [
      { label: "Orders", op: "count" },
      { label: "Cancelled", op: "count", where: { op: "=", args: [{ field: "status" }, { const: "Cancelled" }] } },
      {
        label: "Collected",
        op: "sum",
        field: "total",
        format: "currency",
        where: { op: "=", args: [{ field: "status" }, { const: "PAID" }] },
      },
      { label: "By customer", op: "sum", field: "total", by: "customer_name" },
    ],
    { currency_fields: ["currency"] }
  );
  check("every order in the store is counted", sout[0]?.count === 3);
  check("the derived status is what the stat sees", sout[1]?.count === 1);
  check(
    "collected leaves the cancelled one out, in the shop's currency",
    Number(sout[2]?.value) === 350 && JSON.stringify(sout[2]?.currencies) === '["INR"]'
  );
  check(
    "grouped by the joined name",
    sout[3]?.groups?.[0]?.key === "Zed" && Number(sout[3]?.groups?.[0]?.value) === 650
  );
  if (fails.length) show(sout);
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nthe number on the card is the section's" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
