// The screen check on a real model, over three written screens kept here:
//
//   a  a rough returns screen: a dropdown left to the computer, PENDING and
//      2026-10-02T00:15:00Z printed raw, money unformatted, an empty Actions
//      column, an exchanges table empty with nothing said → redo
//      (the kit draws even a native <select> in the app's style while it is
//      closed, so that one shows only in the code, not in a picture)
//   b  a scanner screen built from the kit, every value as the app writes it → pass
//   c  a screen whose fixed-width row runs off a phone's 390 pixels → redo
//
// Photographed when SCREEN_SNAPSHOT_ID is set (a sandbox each, billed),
// read as code otherwise. Model tier: real calls, by hand, when the
// check's rules or model change, never in CI. It prints what it spent.
//
//   ANTHROPIC_UX_MODEL=… node --env-file=.env.local --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-ux-eval.mjs
//   (a real key in the environment; MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { keyFor } from "../src/lib/model-tape.ts";
import { dollars } from "../src/lib/model-prices.ts";
import { metered } from "../src/lib/usage.ts";
import { reviewScreens } from "../src/lib/ux-review.ts";

const model = process.env.ANTHROPIC_UX_MODEL?.trim();
if (!model || !keyFor(process.env.ANTHROPIC_API_KEY)) {
  console.log("ANTHROPIC_UX_MODEL and ANTHROPIC_API_KEY are both needed; nothing checked");
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const section = (name, title, html, columns, rows) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: { name, nav_label: title, icon: "box" },
  newSchema: { columns },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: { view: { type: "custom", title, html } },
  automation: null,
  automationRemoveName: null,
  newRecords: rows,
  explanation: "",
});

const returnRows = Array.from({ length: 8 }, (_, i) => ({
  order_no: `#${1040 + i}`,
  kind: "return",
  status: ["PENDING", "APPROVED", "PARTIALLY_REFUNDED"][i % 3],
  requested: `2026-10-0${(i % 9) + 1}T0${i}:15:00Z`,
  amount: 450 + i * 120,
}));
const returnColumns = [
  { field: "order_no", label: "Order", type: "text" },
  { field: "kind", label: "Kind", type: "dropdown" },
  { field: "status", label: "Status", type: "badge" },
  { field: "requested", label: "Requested", type: "date" },
  { field: "amount", label: "Amount", type: "currency" },
];

const rough = section(
  "returns",
  "Returns desk",
  `<div style="padding:8px"><b>Returns</b> <select data-native id=f><option>All</option><option>PENDING</option><option>APPROVED</option></select>
<table id=t style="width:100%"><tr><th>Order</th><th>Status</th><th>Requested</th><th>Amount</th><th>Actions</th></tr></table>
<p><b>Exchanges</b></p><table id=x style="width:100%"><tr><th>Order</th><th>Swap for</th></tr></table></div>
<script>wl.onRows((rows) => {
  t.innerHTML = "<tr><th>Order</th><th>Status</th><th>Requested</th><th>Amount</th><th>Actions</th></tr>" + rows.filter((r) => r.data.kind === "return").map((r) => "<tr><td>" + r.data.order_no + "</td><td>" + r.data.status + "</td><td>" + r.data.requested + "</td><td>" + r.data.amount + "</td><td></td></tr>").join("");
  x.innerHTML = "<tr><th>Order</th><th>Swap for</th></tr>" + rows.filter((r) => r.data.kind === "exchange").map((r) => "<tr><td>" + r.data.order_no + "</td><td></td></tr>").join("");
});</script>`,
  returnColumns,
  returnRows
);

const clean = section(
  "packing",
  "Packing station",
  `<div class="wl-page">
  <div class="wl-head"><h1>Packing</h1><span class="wl-badge info" id=left></span></div>
  <input class="wl-scan" id=scan placeholder="Scan an order's barcode" autofocus>
  <div class="wl-banner" id=said>Scan an order to start packing it.</div>
  <div class="wl-card wl-stack"><div class="wl-label">Packed today</div><div class="wl-count big" id=done>0</div></div>
  <div class="wl-list" id=list></div>
</div>
<script>
let rows = [];
const draw = () => {
  const open = rows.filter((r) => r.data.status !== "PACKED");
  left.textContent = open.length + " to pack";
  done.textContent = rows.length - open.length;
  list.innerHTML = open.length ? "" : '<div class="wl-empty">Nothing waiting. New orders appear here as they come in.</div>';
  for (const r of open) {
    const row = document.createElement("div");
    row.className = "wl-row";
    const name = document.createElement("div");
    name.innerHTML = '<div class="wl-big"></div><div class="wl-muted"></div>';
    name.firstChild.textContent = r.data.order_no;
    name.lastChild.textContent = r.data.items + (r.data.items === 1 ? " item" : " items") + " · ordered " + wl.date(r.data.ordered);
    const badge = document.createElement("span");
    badge.className = "wl-badge warn";
    badge.textContent = wl.label(r.data.status);
    row.append(name, badge);
    list.append(row);
  }
};
wl.onRows((r) => { rows = r; draw(); });
scan.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const hit = rows.find((r) => r.data.order_no === scan.value.trim());
  said.className = "wl-banner " + (hit ? "ok" : "bad");
  said.textContent = hit ? "Packing " + hit.data.order_no + "." : "No open order " + scan.value + ".";
  scan.value = "";
});
</script>`,
  [
    { field: "order_no", label: "Order", type: "barcode" },
    { field: "items", label: "Items", type: "number" },
    { field: "status", label: "Status", type: "badge" },
    { field: "ordered", label: "Ordered", type: "date" },
  ],
  Array.from({ length: 5 }, (_, i) => ({
    order_no: `#${2050 + i}`,
    items: (i % 3) + 1,
    status: i === 4 ? "PACKED" : "UNFULFILLED",
    ordered: `2026-10-0${i + 1}`,
  }))
);

const wide = section(
  "stock",
  "Stock board",
  `<div class="wl-page"><h1>Stock</h1>
<div style="display:grid;grid-template-columns:repeat(5,220px);gap:12px;white-space:nowrap" id=g></div></div>
<script>wl.onRows((rows) => {
  g.innerHTML = rows.map((r) => '<div class="wl-card"><div class="wl-label">' + r.data.sku + '</div><div class="wl-count">' + r.data.on_hand + '</div><div class="wl-muted">' + r.data.title + '</div></div>').join("");
});</script>`,
  [
    { field: "sku", label: "SKU", type: "text" },
    { field: "title", label: "Product", type: "text" },
    { field: "on_hand", label: "On hand", type: "number" },
  ],
  Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${300 + i}`,
    title: `Cotton kurta, size ${["S", "M", "L", "XL", "XXL"][i % 5]}`,
    on_hand: 4 + i * 3,
  }))
);

const ctx = {
  db: {},
  projectId: "eval",
  store: null,
  modules: [],
  schemas: new Map(),
  ownerWords: "",
  understood: "",
  locale: "en-IN",
  currency: "INR",
  uxModel: model,
};

console.log(
  `the screen check on ${model}, ${process.env.SCREEN_SNAPSHOT_ID ? "photographed in a sandbox" : "read as code (no SCREEN_SNAPSHOT_ID)"}`
);
let spent = 0;
for (const [name, plan, expect] of [
  ["a  rough returns screen", rough, "redo"],
  ["b  kit-built packing screen", clean, "pass"],
  ["c  a row too wide for a phone", wide, "redo"],
]) {
  const [v, usage] = await metered(() => reviewScreens(ctx, [plan]));
  const u = usage();
  spent += u?.usd ?? 0;
  console.log(`\n${name}  (${v.how}, ${v.ms}ms, ${u ? dollars(u.usd) : "no usage"})`);
  for (const i of v.issues) console.log(`     · ${i}`);
  if (v.fix) console.log(`     → ${v.fix}`);
  check(`${expect === "redo" ? "sent back" : "passed"}`, v.verdict === expect);
}

console.log(`\nspent ${dollars(spent)}`);
console.log(
  fails.length === 0 ? "the screen check sends back what hinders and passes what does not" : `${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
