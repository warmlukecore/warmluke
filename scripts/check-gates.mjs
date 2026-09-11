// Gate checks.
//
// Both of these started as prompt rules and both were broken by the
// model anyway: a scan that declared a quantity it never counted, and a
// workflow step claiming a wrong scan does nothing on screen. Prompt
// rules fail quietly; these fail loudly.
//
//   node scripts/check-gates.mjs

import { isTransient, validateFeatures, parseReply } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const columns = [
  { field: "barcode", label: "Barcode", type: "barcode" },
  { field: "qty_ordered", label: "Qty Ordered", type: "number" },
  { field: "qty_packed", label: "Qty Packed", type: "number" },
  { field: "item_status", label: "Status", type: "badge", options: ["Pending", "Verified"] },
];
const scan = (set) => {
  const errors = [];
  validateFeatures(
    { scanMode: { lookupField: "barcode", action: { label: "Verify", set } } },
    columns,
    errors
  );
  return errors;
};

console.log("\na scan cannot declare a count it never took");
check(
  "copying the ordered quantity is refused",
  scan({ qty_packed: { field: "qty_ordered" } }).some((e) => /without counting/.test(e))
);
check(
  "writing a flat number is refused",
  scan({ qty_packed: { const: 5 } }).some((e) => /without counting/.test(e))
);
check(
  "adding one to itself is allowed",
  scan({ qty_packed: { op: "+", args: [{ field: "qty_packed" }, { const: 1 }] } }).length === 0
);
check(
  "a status decided from that count is allowed",
  scan({
    qty_packed: { op: "+", args: [{ field: "qty_packed" }, { const: 1 }] },
    item_status: {
      op: "if",
      args: [
        { op: ">=", args: [{ op: "+", args: [{ field: "qty_packed" }, { const: 1 }] }, { field: "qty_ordered" }] },
        { const: "Verified" },
        { const: "Pending" },
      ],
    },
  }).length === 0
);
check(
  "non-number fields are left alone",
  scan({ item_status: { const: "Verified" } }).length === 0
);

console.log("\nthe engine states what scanning does, not the model");
const blueprint = parseReply(
  JSON.stringify({
    type: "blueprint",
    message: "Here is the design",
    blueprint: {
      summary: "Packing verification",
      workflow: [
        { step: "Order aata hai website se", who: "Aap" },
        { step: "Barcode scan karo — galat product pe kuch nahi hoga screen pe", who: "Aap" },
        { step: "Dispatch karo", who: "Aap" },
      ],
      unmet: [],
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "order-items", nav_label: "Order Items", icon: "package" },
          newSchema: {
            columns,
            features: { scanMode: { lookupField: "barcode", action: { label: "Verify", set: { item_status: { const: "Verified" } } } } },
          },
          explanation: "Every product in an order, scanned to verify.",
        },
      ],
    },
  }),
  [],
  null,
  null
);

if (!blueprint.ok) {
  check(`blueprint parsed (${blueprint.errors?.join("; ")})`, false);
} else {
  const steps = blueprint.reply.blueprint.workflow.map((w) => w.step);
  check("the model's scan claim is dropped", !steps.some((s) => /kuch nahi hoga/.test(s)));
  check("the engine's own scan step is added", steps.some((s) => /refused on screen/.test(s)));
  check("it names the real lookup field", steps.some((s) => /Scan a barcode/.test(s)));
  check("the ambiguous-code behaviour is stated", steps.some((s) => /asks which one/.test(s)));
  check("the owner's real-world steps survive", steps.some((s) => /Order aata hai/.test(s)));
}

console.log("\na scanner that was never built cannot be described either");
const noScanner = parseReply(
  JSON.stringify({
    type: "blueprint",
    message: "Here is the design",
    blueprint: {
      summary: "Packing verification",
      workflow: [
        { step: "Order aata hai website se", who: "Aap" },
        { step: "Har item ka SKU scan karo — scanner qty_packed badhayega", who: "Aap" },
      ],
      unmet: [],
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "order-items", nav_label: "Order Items", icon: "package" },
          newSchema: { columns, features: {} },
          explanation: "Every product in an order.",
        },
      ],
    },
  }),
  [],
  null,
  null
);
if (!noScanner.ok) {
  check(`blueprint parsed (${noScanner.errors?.join("; ")})`, false);
} else {
  const steps = noScanner.reply.blueprint.workflow.map((w) => w.step);
  check("a promised-but-absent scanner is not described", !steps.some((s) => /scan/i.test(s)));
  check("no invented scan step is added either", !steps.some((s) => /refused on screen/.test(s)));
  check("the real steps still survive", steps.some((s) => /Order aata hai/.test(s)));
}

console.log("\nevery gate that recommends a way out has one that opens");
// Twice in one afternoon a gate refused something and left the model
// nowhere to go: three repairs spent, and the owner handed an error
// where a design belonged. A rejection is only finished when the shape
// it recommends is known to validate.
const tools = [
  { field: "tool_name", label: "Tool", type: "text" },
  { field: "date_taken", label: "Date Taken", type: "date" },
  { field: "status", label: "Status", type: "badge", options: ["Out", "Returned", "Overdue"] },
];
const toolsModule = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "tools",
  nav_label: "Tools",
  icon: "wrench",
  sort_order: 0,
  project_id: "p",
  parent_id: null,
};
const overdueRule = parseReply(
  JSON.stringify({
    type: "plans",
    plans: [
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: toolsModule.id,
        newModule: null,
        newSchema: null,
        explanation: "Flag a tool nobody brought back.",
        automation: {
          name: "Flag overdue tools",
          definition: {
            trigger: {
              type: "schedule",
              every: "daily",
              when: {
                op: "and",
                args: [
                  { op: ">", args: [{ op: "days_since", args: [{ field: "date_taken" }] }, { const: 7 }] },
                  { op: "=", args: [{ field: "status" }, { const: "Out" }] },
                ],
              },
            },
            actions: [
              { type: "set_fields", target: { self: true }, set: { status: { const: "Overdue" } } },
            ],
          },
        },
      },
    ],
  }),
  [toolsModule],
  { columns: tools },
  null
);
check(
  "the schedule shape the clock-write rejection recommends validates",
  overdueRule.ok === true
);
if (!overdueRule.ok) console.log("     ", overdueRule.errors.join(" | "));

console.log("\nonly a transient failure is worth retrying");
// Retrying a rejected request or a bad key only delays the error the
// caller has to see; retrying a busy server is the whole point.
const transient = [
  "Gemini API error 503: model is currently experiencing high load",
  "Gemini API error 429: quota exceeded",
  "Gemini API error 500: internal",
  "fetch failed: timeout",
  "Service temporarily overloaded",
];
const permanent = [
  "Gemini API error 400: invalid argument",
  "Gemini API error 401: API key not valid",
  "Gemini API error 404: model not found",
  "GEMINI_API_KEY is not set.",
];
check("busy, rate-limited and broken all retry", transient.every((m) => isTransient(new Error(m))));
check("rejected, unauthorised and missing do not", permanent.every((m) => !isTransient(new Error(m))));

console.log(fails.length === 0 ? "\nall gates hold" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
