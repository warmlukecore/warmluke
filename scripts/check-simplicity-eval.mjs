// The simplicity reviewer on four designs, on a real model.
//
//   a  the RTO tangle: an rto_status beside the RTO tick, an hourly rule
//      writing "No" into every row, a "simple table" tab of the same rows  → redo
//   b  the clean RTO tick: one tick on the store's orders and a count      → simple
//   c  a returns screen written to show a list a table would show          → redo
//   d  a packing screen that takes scans and ticks lines as packed        → simple
//
// Each is handed what the gate hands it: the ask, what will be built
// (describeBuild, screens' code and all), the app's sections, and the
// signs workaroundSigns finds. A redo must name the simpler way and ask
// for nothing more. Model tier: real calls, by hand, when the reviewer's
// prompt or model changes; never in CI. It prints what it spent. Run it
// before turning ANTHROPIC_REVIEW_MODEL on.
//
//   ANTHROPIC_REVIEW_MODEL=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-simplicity-eval.mjs
//   (a real key in the environment; MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { reviewModel } from "../src/lib/ai.ts";
import { describeBuild } from "../src/lib/judge.ts";
import { keyFor } from "../src/lib/model-tape.ts";
import { dollars } from "../src/lib/model-prices.ts";
import { simplicityReview, workaroundSigns } from "../src/lib/reviewers.ts";
import { metered } from "../src/lib/usage.ts";

const model = reviewModel();
if (!model || !keyFor(process.env.ANTHROPIC_API_KEY)) {
  console.log("ANTHROPIC_REVIEW_MODEL and ANTHROPIC_API_KEY are both needed; nothing checked");
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const ORDERS = "11111111-1111-4111-8111-111111111111";
const modules = [
  {
    id: ORDERS,
    project_id: "p",
    parent_id: null,
    name: "orders",
    nav_label: "Orders",
    icon: "shopping-cart",
    route: "/orders",
    sort_order: 0,
    source_table: "orders",
    created_at: "",
  },
];
const orderColumns = [
  { field: "order_number", label: "Order", type: "text" },
  { field: "placed_at", label: "Placed", type: "date" },
  { field: "fulfillment_status", label: "Fulfilment", type: "badge" },
];
const withRto = [...orderColumns, { field: "rto", label: "RTO", type: "boolean" }];
const plan = (p) => ({
  targetModuleId: null,
  newModule: null,
  newSchema: { columns: [] },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
  ...p,
});
const lines = (cols) => [
  `- Orders [id ${ORDERS}] — over the store's orders: ${cols.map((c) => `${c.field} (${c.type})`).join(", ")}`,
];

const cases = [
  {
    name: "a  the RTO tangle",
    ask: "RTO wale orders mark karne hain, aur ek simple list chahiye jisme dikhe",
    columns: withRto,
    plans: [
      plan({
        changeType: "FIELD_ADD",
        targetModuleId: ORDERS,
        newSchema: { columns: [{ field: "rto_status", label: "RTO status", type: "dropdown" }] },
      }),
      plan({
        changeType: "AUTOMATION_ADD",
        targetModuleId: ORDERS,
        automation: {
          name: "Fill RTO status",
          definition: {
            trigger: { type: "schedule", every: "hourly" },
            actions: [{ type: "set_fields", target: { self: true }, set: { rto_status: { const: "No" } } }],
          },
        },
      }),
      plan({
        changeType: "FEATURE_UPDATE",
        targetModuleId: ORDERS,
        features: { tabs: [{ type: "table", label: "Simple table" }] },
      }),
    ],
    want: "redo",
  },
  {
    name: "b  the clean RTO tick",
    ask: "I want to mark which orders came back RTO and see how many",
    columns: orderColumns,
    plans: [
      plan({
        changeType: "FIELD_ADD",
        targetModuleId: ORDERS,
        newSchema: { columns: [{ field: "rto", label: "RTO", type: "boolean" }] },
      }),
      plan({
        changeType: "FEATURE_UPDATE",
        targetModuleId: ORDERS,
        features: {
          stats: [{ label: "RTO", op: "count", where: { field: "rto" } }],
          filters: [{ field: "rto", label: "RTO", options: ["Yes", "No"] }],
        },
      }),
    ],
    want: "simple",
  },
  {
    name: "c  a returns screen a table would do",
    ask: "Keep a list of returns with the order, the reason and whether it is refunded",
    columns: orderColumns,
    plans: [
      plan({
        changeType: "NEW_MODULE",
        newModule: { name: "returns", nav_label: "Returns", icon: "undo-2" },
        newSchema: {
          columns: [
            { field: "order_number", label: "Order", type: "text" },
            { field: "reason", label: "Reason", type: "dropdown" },
            { field: "refunded", label: "Refunded", type: "boolean" },
          ],
        },
        features: {
          view: {
            type: "custom",
            title: "Returns",
            html: `<div class="wl-page"><h2>Returns</h2><table id="t"><thead><tr><th>Order</th><th>Reason</th><th>Refunded</th></tr></thead><tbody></tbody></table></div><script>wl.onRows(rows => { document.querySelector("#t tbody").innerHTML = rows.map(r => "<tr><td>" + r.data.order_number + "</td><td>" + r.data.reason + "</td><td>" + (r.data.refunded ? "Yes" : "No") + "</td></tr>").join(""); });</script>`,
          },
        },
      }),
    ],
    want: "redo",
  },
  {
    name: "d  a packing screen that scans",
    ask: "Packers scan the order label, then each item, and it ticks the line packed; when all lines are packed the order is done",
    columns: orderColumns,
    plans: [
      plan({
        changeType: "NEW_MODULE",
        newModule: { name: "packing", nav_label: "Packing", icon: "scan-line", source_table: "order_line_items" },
        newSchema: { columns: [{ field: "packed", label: "Packed", type: "boolean" }] },
        features: {
          view: { type: "table" },
          tabs: [
            {
              type: "custom",
              title: "Packing station",
              html: `<div class="wl-page"><input id="scan" autofocus placeholder="Scan the order label"><div id="lines"></div></div><script>let order=null; const box=document.getElementById("scan"); box.addEventListener("keydown", async e => { if (e.key !== "Enter") return; const v=box.value.trim(); box.value=""; if (!order) { order=v; const rows = await wl.find("order_number", v); document.getElementById("lines").textContent = rows.length + " lines"; return; } const rows = await wl.find("sku", v); const line = rows.find(r => r.data.order_number === order && !r.data.packed); if (line) await wl.set(line.id, { packed: true }); else await wl.ask("Not in this order", "OK"); });</script>`,
            },
          ],
        },
      }),
    ],
    want: "simple",
  },
];

let spent = 0;
for (const c of cases) {
  const schemas = new Map([[ORDERS, { columns: c.columns, features: null }]]);
  const signs = workaroundSigns(c.plans, modules, schemas);
  const t0 = Date.now();
  const [v, usage] = await metered(() =>
    simplicityReview({
      ownerWords: c.ask,
      understood: "",
      built: describeBuild(c.plans, modules, c.columns, null, { screens: true }),
      columnLines: lines(c.columns),
      signs,
      model,
    })
  );
  const u = usage();
  spent += u?.usd ?? 0;
  console.log(`\n${c.name}  (${Date.now() - t0}ms, ${u ? dollars(u.usd) : "no usage"})`);
  console.log(`     signs: ${signs.length ? signs.join(" | ") : "none"}`);
  console.log(`     → ${JSON.stringify(v)}`);
  if (!v) {
    check("a verdict came back", false);
    continue;
  }
  check(`"${c.want}"`, v.verdict === c.want);
  if (v.verdict === "redo") {
    check("the redo names the simpler way", !!v.redo && v.redo.length > 10);
    check("and asks for nothing more", !/\b(also add|add a new|another field|in addition)\b/i.test(v.redo ?? ""));
  }
}

console.log(`\nspent ${dollars(spent)} on ${model}`);
console.log(
  fails.length === 0
    ? "the reviewer sends back the tangles and lets the sound designs through"
    : `${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
