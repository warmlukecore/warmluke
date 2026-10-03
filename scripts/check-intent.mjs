// Which road a message takes: only how to answer, or the whole design
// contract. Decided in code; a wrong turn onto the design road costs
// tokens, a wrong turn onto the talk road is handed back by the model,
// so when unsure it is the design road.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-intent.mjs

import { lastReplyTypeOf, roadFor } from "../src/lib/intent.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const road = (message, over = {}) => roadFor({ message, lastReplyType: null, routed: false, ...over });

console.log("talk: a greeting, a question, a store question");
for (const m of [
  "hello",
  "hi Luke, kaise ho",
  "thanks!",
  "who are you?",
  "what can you do",
  "how does my Packing section work?",
  "kitna stock bacha hai",
  "which orders are still unpaid?",
  "how are sales this month",
  "Is order #1003 paid? How much was it?",
  "kya mere top customers Delhi se hain",
  // As people type them (2 Oct: "hows" went to the design road, $0.25).
  "hows my store doing since the past 15 days",
  "whats my best seller this month",
  "give me last weeks pnl",
  "batao is hafte kitni sale hui",
  "store kaisa chal raha hai",
]) {
  check(`"${m}"`, road(m) === "talk");
}
check("a follow-up to an answer", road("and last month", { lastReplyType: "answer" }) === "talk");
check("same for another city", road("same for Delhi", { lastReplyType: "answer" }) === "talk");
check(
  "but a change asked after an answer is a design",
  road("ok add that as a section", { lastReplyType: "answer" }) === "design"
);
check(
  "a question the router already read as one about a list",
  road("top 3 cities by sales", { routed: true }) === "talk"
);

console.log("\ndesign: work to build, an edit, an answer to Luke's question");
for (const m of [
  "add a search bar",
  "rename this section to Jobs",
  "build me a packing app with barcode scanning",
  "I want to scan each order and mark it packed",
  "mujhe returns track karne hain",
  "ek rule banao: jab packed ho to date likh do",
  "can you add a field for the courier?",
  "please remove the demo rows",
  "Before the courier comes we pack every order and I only find out later what was missed",
  "what if I could scan the courier handover too, like packing?",
  "would it be possible to track returns as well?",
  "kya isme reminder add ho sakta hai?",
  // Asked to be told: an alert rule, not a question.
  "tell me when a COD order over 5000 comes in",
  "notify me when stock goes below 5",
  "show me orders as a board",
]) {
  check(`"${m}"`, road(m) === "design");
}
check(
  "an answer to a question Luke asked",
  road("When do you want to hear?\n→ Every morning", { lastReplyType: "clarify" }) === "design"
);
check("a yes to a design", road("yes go ahead", { lastReplyType: "blueprint" }) === "design");
check('"ok" while a design waits is not a greeting', road("ok", { lastReplyType: "blueprint" }) === "design");
check("something unclear takes the design road", road("courier") === "design");

console.log("\nwhat Luke last said");
const thread = (raw) => [
  { role: "user", content: "x" },
  { role: "assistant", content: raw },
  { role: "user", content: "y" },
];
check("a question", lastReplyTypeOf(thread('{"type":"clarify","questions":[]}')) === "clarify");
check("a design", lastReplyTypeOf(thread('{"type":"blueprint","blueprint":{}}')) === "blueprint");
check("an answer", lastReplyTypeOf(thread('{"type":"answer","message":"Two."}')) === "answer");
check("nothing yet", lastReplyTypeOf([{ role: "user", content: "hello" }]) === null);

console.log(fails.length === 0 ? "\na turn takes the road its words ask for" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
