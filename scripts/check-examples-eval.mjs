// Designs that worked, on the real model (lib/examples.ts, 4b, 5 Oct): six
// asks near the seeds' kind of work but not theirs, each planned twice by
// the plan step, without the examples and with the ones it would be
// handed. Read side by side: does the plan build on the store's own rows
// more, add less, and copy nothing that does not fit? Model tier, by hand
// (paid: a yes first), when the seeds or the block change; stops before
// --max-usd. The log is the record.
//
//   (set -a; . ./.env.anthropic.local; set +a; ANTHROPIC_PLAN_MODEL=claude-opus-5-5 \
//    node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-examples-eval.mjs --max-usd 0.6)

import { buildPlanPrompt, buildUserMessage, callModel, planModel } from "../src/lib/ai.ts";
import { describeExamples, examplesFor } from "../src/lib/examples.ts";
import { priceOf } from "../src/lib/model-prices.ts";
import { parseIntent } from "../src/lib/plan.ts";
import { metered } from "../src/lib/usage.ts";

const model = planModel();
if (!model || !process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_PLAN_MODEL and ANTHROPIC_API_KEY are both needed; nothing checked");
  process.exit(0);
}
if (!priceOf(model)) {
  console.log(`${model} has no price, so no cap can be held; nothing checked`);
  process.exit(1);
}
const at = process.argv.indexOf("--max-usd");
const cap = at > 0 ? Number(process.argv[at + 1]) : 0.6;
const GUESS = 0.05;

const store = {
  shop_domain: "shop.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  importing: false,
  counts: { orders: 2100, customers: 1400, products: 120, inventory_levels: 260, fulfillments: 1900 },
  values: {
    "orders.gateway": ["Cash on Delivery (COD)", "Razorpay"],
    "fulfillments.shipment_status": ["DELIVERED", "IN_TRANSIT", "FAILURE"],
  },
};

const ASKS = [
  "dispatch se pehle check karna hai ki box mein sahi cheezein gayi, humare paas scanner hai",
  "Delhivery aur Shiprocket COD settle karte hain, kaunse order ka paisa abhi tak nahi aaya pata nahi chalta",
  "we gift products to creators for reels, need to know who actually delivered the content",
  "fabric vendor se maal aata hai, kabhi kam aata hai, aur payment bhi baaki reh jaata hai",
  "corporate gifting ke bulk orders aate hain, half advance half delivery pe, hisaab rakhna hai",
  "customers WhatsApp pe complaint karte hain late delivery ki, reply karna bhool jaate hain",
];

const plan = async (ask, examples) => {
  const [contract, context] = buildPlanPrompt([], "Shop", "en-IN", "INR", store, null);
  const [raw, usage] = await metered(() =>
    callModel({
      system: [contract, context + examples],
      turns: [{ role: "user", content: buildUserMessage(ask, null, null, null, [], [], []) }],
      model,
    })
  );
  return { intent: parseIntent(raw), usd: usage()?.usd ?? GUESS };
};
const show = (label, i) =>
  i
    ? [
        `   ${label}: rows ${i.rows}`,
        `     facts (${i.facts.length}): ${i.facts.join(" | ")}`,
        `     rules (${i.rules.length}): ${i.rules.join(" | ") || "none"}`,
        `     screens: ${i.screens.join(" | ")}`,
      ].join("\n")
    : `   ${label}: did not parse`;

let spent = 0;
let fewer = 0;
let same = 0;
let more = 0;
let parsed = 0;
for (const ask of ASKS) {
  if (spent + 2 * GUESS > cap) {
    console.log(`\nstopped: ${spent.toFixed(3)} spent of ${cap}`);
    break;
  }
  const near = examplesFor(ask);
  const [bare, helped] = await Promise.all([plan(ask, ""), plan(ask, describeExamples(near))]);
  spent += bare.usd + helped.usd;
  console.log(`\n"${ask}"\n   shown: ${near.map((e) => e.id).join(", ") || "none"}`);
  console.log(show("without", bare.intent));
  console.log(show("with   ", helped.intent));
  if (bare.intent && helped.intent) {
    parsed++;
    const a = bare.intent.facts.length + bare.intent.rules.length;
    const b = helped.intent.facts.length + helped.intent.rules.length;
    if (b < a) fewer++;
    else if (b === a) same++;
    else more++;
  }
}
console.log(
  `\n${parsed} pairs on ${model}: with examples the plan added less in ${fewer}, the same in ${same}, more in ${more}; $${spent.toFixed(3)} spent`
);
process.exit(parsed > 0 ? 0 : 1);
