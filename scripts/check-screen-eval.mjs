// Luke on the screen open, on the real model (lib/screen.ts, #3, 5 Oct):
// with a Returns section open, eight things a merchant says, in their
// words, each read through the talk road's own prompt and the code that
// holds an answer's "show" to the section. Asked to see rows a way, the
// screen is set so; given a row, the form is filled; asked how something
// works, the screen is left alone. Model tier: real calls, by hand, when
// ON THEIR SCREEN or the talk model changes; the log is the record.
//
//   (set -a; . ./.env.anthropic.local; set +a; node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-screen-eval.mjs)
//   (MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { buildTalkPrompt, buildUserMessage, callModel, stripFences, talkModel } from "../src/lib/ai.ts";
import { shownOnScreen } from "../src/lib/engine.ts";

const model = talkModel();
const schema = {
  columns: [
    { field: "order", label: "Order", type: "link", linkTo: "m-orders" },
    { field: "customer_name", label: "Customer", type: "text" },
    { field: "reason", label: "Reason", type: "dropdown" },
    { field: "status", label: "Status", type: "badge" },
    { field: "amount", label: "Amount", type: "currency" },
    { field: "received", label: "Received on", type: "date" },
  ],
  features: {
    filters: [
      { field: "status", label: "Status", options: ["Requested", "Received", "Refunded"] },
      { field: "reason", label: "Reason", options: ["Size", "Damaged", "Wrong item"] },
    ],
    period: { field: "received", presets: [7, 30] },
    actions: [{ label: "Received", set: { status: { const: "Received" } } }],
  },
};
const now = new Date().toISOString();
const modules = [
  {
    id: "m-orders",
    project_id: "p",
    parent_id: null,
    name: "orders",
    nav_label: "Orders",
    icon: "cart",
    route: "/",
    sort_order: 0,
    source_table: "orders",
    created_at: now,
  },
  {
    id: "m-returns",
    project_id: "p",
    parent_id: null,
    name: "returns",
    nav_label: "Returns",
    icon: "table",
    route: "/",
    sort_order: 1,
    source_table: null,
    created_at: now,
  },
];
const open = modules[1];

const cases = [
  ["sirf waiting wale dikhao", (s) => s?.filters?.status === "Requested"],
  ["Asha ka return dhundo", (s) => /asha/i.test(s?.search ?? "")],
  ["newest pehle dikhao", (s) => s?.sort?.field === "received" && s.sort.dir === "desc"],
  ["pichle hafte ke returns", (s) => s?.period?.named === "last_week" || !!s?.period?.from],
  [
    "damaged wale jo abhi receive nahi hue",
    (s) => s?.filters?.reason === "Damaged" && s?.filters?.status === "Requested",
  ],
  [
    "Hi, maine order #1042 mangaya tha, size chhota nikla, return karna hai.\n- Neha",
    (s) => s?.add?.order === "#1042" && /neha/i.test(String(s?.add?.customer_name ?? "")) && s?.add?.reason === "Size",
  ],
  [
    "Ravi ka return aa gaya, 1200 ka tha, damaged",
    (s) => /ravi/i.test(String(s?.add?.customer_name ?? "")) && s?.add?.amount === 1200 && s?.add?.reason === "Damaged",
  ],
  ["Received button kya karta hai?", (s) => !s?.said],
];

let good = 0;
for (const [ask, fits] of cases) {
  const t0 = Date.now();
  const raw = await callModel({
    system: buildTalkPrompt(modules, "Shop", "en-IN", "INR", null, null),
    turns: [{ role: "user", content: buildUserMessage(ask, open.id, schema, schema.features, [], [], []) }],
    model,
  });
  let said = null;
  try {
    said = JSON.parse(stripFences(raw));
  } catch {
    /* said below */
  }
  const shown = shownOnScreen(raw, open, schema);
  const ok = said?.type === "answer" && fits(shown);
  if (ok) good++;
  console.log(`\n${ok ? "ok  " : "FAIL"}  ${ask.replace(/\n/g, " / ")}  (${Date.now() - t0}ms)`);
  console.log(
    `      ${said?.type ?? "no JSON"}: ${String(said?.message ?? raw)
      .slice(0, 160)
      .replace(/\n/g, " ")}`
  );
  if (shown)
    console.log(
      `      show: ${shown.said || "(nothing)"}${shown.left?.length ? ` · left: ${shown.left.join("; ")}` : ""}`
    );
  if (shown?.add) console.log(`      add: ${JSON.stringify(shown.add)}`);
}
const passed = good >= cases.length - 1;
console.log(`\n${good} of ${cases.length} on ${model}${passed ? "" : " — FAILED"}`);
process.exit(passed ? 0 : 1);
