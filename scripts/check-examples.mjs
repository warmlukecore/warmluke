// Designs that worked (lib/examples.ts, 4b, 5 Oct): every seed says what
// was asked, what was built and why; an ask finds the seed for its kind of
// work, small talk and a rename find none, and with none the design prompt
// is exactly what it was. The asks the evals make are shown with what they
// would be handed, so an eval that starts to see its own problem is seen. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-examples.mjs

import { readdirSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "../src/lib/ai.ts";
import { describeExamples, examplesFor, SEED_EXAMPLES } from "../src/lib/examples.ts";
import { exampleFromBuild, plansOf, scrubAsk } from "../src/lib/curator.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("every seed, whole");
check("eight of them", SEED_EXAMPLES.length === 8);
check("each id once", new Set(SEED_EXAMPLES.map((e) => e.id)).size === SEED_EXAMPLES.length);
for (const e of SEED_EXAMPLES)
  check(
    `${e.id}: asked, built, why, tags`,
    e.ask.length > 20 && e.design.length > 80 && e.why.length > 20 && e.tags.length >= 3
  );

console.log("\nan ask finds its kind of work");
const first = (m) => examplesFor(m)[0]?.id ?? null;
check(
  "a packer sending the wrong item",
  first("packer galat item bhej deta hai, scan karke pack karna hai") === "seed-packing-desk"
);
check(
  "the courier's COD money",
  first("courier ka COD remittance match karna hai kaunsa paisa aaya") === "seed-cod-remittance"
);
check("influencers", first("track which influencers posted after we sent the product") === "seed-influencer-collabs");
check(
  "a supplier's half delivery",
  first("supplier purchase order ka maal aadha aata hai") === "seed-supplier-restock"
);
check("reviews after delivery", first("ask delivered customers for a review") === "seed-review-requests");
check("two at most", examplesFor("customer follow up complaint review delivered whatsapp").length === 2);
check("small talk: none", examplesFor("hello Luke, kaise ho").length === 0);
check("a rename: none", examplesFor("rename Status to Stage").length === 0);
check("one word in common is not enough", examplesFor("influencer").length === 0);
check(
  "words every store's ask has are not a match",
  examplesFor("flag orders from customers who ordered before").length === 0
);
const kept = {
  id: "kept-1",
  ask: "gift wrap orders alag pack karne hain",
  design: "x".repeat(90),
  why: "y".repeat(30),
  tags: ["gift", "wrap", "packing"],
};
check("an approved kept design is found too", examplesFor("gift wrap orders pack", [kept])[0]?.id === "kept-1");

console.log("\nthe block, and nothing when there is none");
const block = describeExamples(examplesFor("influencers ko product bhejte hain, post kisne kiya"));
check("says what was asked, built and why", /They said:.*\n  Built: .*\n  Why this shape: /.test(block));
check("and to fit it to this owner, never to copy", /never copy a field/.test(block));
check("none: nothing at all", describeExamples([]) === "");
const [, plain] = buildSystemPrompt([], "Shop", "en-IN", "INR", null, null);
const [, none] = buildSystemPrompt([], "Shop", "en-IN", "INR", null, null, "");
const [, withBlock] = buildSystemPrompt([], "Shop", "en-IN", "INR", null, null, block);
check("the design prompt unchanged without one", plain === none);
check("and the block at its end with one", withBlock === plain + block);

console.log("\nwhat the evals' asks would be handed (their problems are not seeds)");
for (const f of readdirSync(new URL("../evals/cases/", import.meta.url)).filter((x) => x.endsWith(".json"))) {
  const text = readFileSync(new URL(`../evals/cases/${f}`, import.meta.url), "utf8");
  const ask = JSON.parse(text).opening ?? text.match(/"(?:opening|ask|first|message|says?)":"([^"]+)/)?.[1] ?? "";
  const got = examplesFor(ask).map((e) => e.id);
  console.log(`     ${f.padEnd(22)} ${got.join(", ") || "none"}`);
}
check(
  "no seed is an eval's own problem",
  SEED_EXAMPLES.every((e) => !/\b(rto|low stock|return|repeat)\b/i.test(e.id))
);

console.log("\na kept build, in words, with nothing of theirs (lib/curator.ts)");
const scrubbed = scrubAsk(
  "Order #1042 ka return, Asha ka phone +91 98100 00001, mail asha@shop.in, link https://shop.in/x, AWB 784512369"
);
check("an order's number goes", !/1042/.test(scrubbed) && /#order/.test(scrubbed));
check("a phone goes", !/98100/.test(scrubbed) && /a phone/.test(scrubbed));
check("an email and a link go", !/@|https?:/.test(scrubbed));
check("a long number goes", !/784512369/.test(scrubbed));
const plans = [
  {
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: { name: "complaints", nav_label: "Complaints", icon: "table" },
    newSchema: {
      columns: [
        { field: "issue", label: "Issue", type: "dropdown" },
        { field: "status", label: "Status", type: "badge" },
      ],
    },
    newRecords: [{ issue: "Late", status: "Open" }],
    explanation: "Complaints to follow up.",
  },
];
check(
  "a card's plans and a blueprint's",
  plansOf({ plans }).length === 1 && plansOf({ blueprint: { plans } }).length === 1
);
const ex = exampleFromBuild("WhatsApp pe complaints aati hain, follow up chhoot jaata hai", { type: "plans", plans });
check(
  "its ask, its design in words, and words to find it by",
  !!ex && /Complaints/.test(ex.design) && ex.tags.includes("complaints")
);
check("nothing built, nothing proposed", exampleFromBuild("follow up chhoot jaata hai", { type: "answer" }) === null);
check("too few words, nothing proposed", exampleFromBuild("ok", { plans }) === null);

console.log(
  fails.length === 0 ? "\na design starts from one that worked, when one is near" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
