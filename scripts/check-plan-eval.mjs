// The plan step over asks it has never seen.
//
// Fifteen merchants, fifteen problems, none of them in any prompt or
// check: the plan step is read on whether it understood them — which
// rows the work belongs to, what happens, what is unsettled. Model
// tier: real calls, by hand, when the plan contract or its model
// changes. The number to hold is the parse rate; the words are for
// reading, and the log is the record.
//
//   ANTHROPIC_PLAN_MODEL=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-plan-eval.mjs
//   (a real key in the environment; MODEL_TAPE=record MODEL_TAPE_DIR=<scratch> keeps the calls out of tapes/)

import { readFileSync } from "node:fs";
import { buildPlanPrompt, buildUserMessage, callModel, planModel } from "../src/lib/ai.ts";
import { parseIntent } from "../src/lib/plan.ts";

const model = planModel();
if (!model) {
  console.log("ANTHROPIC_PLAN_MODEL is not set; nothing checked");
  process.exit(0);
}
const asks = JSON.parse(readFileSync(new URL("./fixtures/hidden-asks.json", import.meta.url), "utf8"));
// A store like a real one: counts and the values a column holds, so a
// plan can say "orders, gateway COD" rather than guess.
const store = {
  shop_domain: "shop.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  importing: false,
  counts: {
    orders: 2100,
    customers: 1400,
    products: 120,
    inventory_levels: 260,
    fulfillments: 1900,
    returns: 40,
    refunds: 55,
  },
  values: {
    "orders.financial_status": ["PAID", "PENDING", "REFUNDED"],
    "orders.gateway": ["Cash on Delivery (COD)", "Razorpay"],
    "orders.fulfilment_status": ["FULFILLED", "UNFULFILLED"],
    "fulfillments.shipment_status": ["DELIVERED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "FAILURE"],
  },
};

let planned = 0;
for (const { merchant, ask } of asks) {
  const t0 = Date.now();
  const raw = await callModel({
    system: buildPlanPrompt([], "Shop", "en-IN", "INR", store, merchant),
    turns: [{ role: "user", content: buildUserMessage(ask, null, null, null, [], [], []) }],
    model,
  });
  const intent = parseIntent(raw);
  if (intent) planned++;
  console.log(`\n${intent ? "ok  " : "FAIL"}  ${ask.slice(0, 100)}  (${Date.now() - t0}ms)`);
  if (intent) {
    console.log(`      rows: ${intent.rows}`);
    console.log(`      work: ${intent.work.join(" | ")}`);
    if (intent.rules.length) console.log(`      rules: ${intent.rules.join(" | ")}`);
    if (intent.unsure.length) console.log(`      unsure: ${intent.unsure.join(" | ")}`);
  } else console.log(`      → ${raw.slice(0, 200).replace(/\n/g, " ")}`);
}
const ok = planned >= asks.length - 1;
console.log(`\n${planned} of ${asks.length} planned on ${model}${ok ? "" : " — FAILED"}`);
process.exit(ok ? 0 : 1);
