// The Luke eval's own logic, without a model, a server or a database.
//
// scripts/eval-luke.mjs spends real money on every case, so what it
// decides on its own has to be right before it is run: the cases it reads,
// the grader's answer it believes, the signs it counts, the cap it holds
// and the numbers it writes. All of that is plain functions, tested here
// on fixtures. The conversation itself is the paid part, and is not.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-eval-harness.mjs

import {
  COMMON_MUST_NOT,
  COMMON_SUCCESS,
  CapReached,
  KINDS,
  answerChecks,
  asksFirstCheck,
  buildChecks,
  cantIn,
  capableCheck,
  converse,
  effectCheck,
  fillDates,
  honestCheck,
  numbersIn,
  outcomeChecks,
  pickColumn,
  selectCases,
  valuesCheck,
  LUKE_TURN_USD,
  capMeter,
  caseProblems,
  describeBuild,
  estimateUsd,
  jargonIn,
  jsonOf,
  loadCases,
  lukeEstimate,
  ownerText,
  parseArgs,
  parseGrade,
  parseSim,
  privateBits,
  quoteFound,
  replyText,
  runFileName,
  runModule,
  stepLine,
  workaroundSigns,
} from "./eval-luke.mjs";
import { casePassed, scoreOf, signCount, summarise } from "../src/lib/eval-report.ts";
import { EXPECT, expectationFor, viewOf } from "../evals/expect.mjs";
import { SHOPS } from "./fixtures/shops.ts";
import { shopNodes } from "./fixtures/business-shop.ts";
import { seedNodes } from "./fixtures/seed-shop.ts";
import { RESOURCES } from "../src/lib/shopify-resources.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 300));

console.log("the cases");
const cases = loadCases();
const ids = cases.map((x) => x.case.id);
check(
  "the eight first owners are all still there",
  [
    "cod-confirm",
    "low-stock",
    "repeat-customers",
    "repeat-orders",
    "return-reasons",
    "returns-screen",
    "rto-cleanup",
    "rto-new",
  ].every((id) => ids.includes(id))
);
check(
  "and about thirty in all, across every kind",
  ids.length >= 30 && KINDS.every((k) => cases.some((x) => (x.case.kind ?? "build") === k))
);
for (const { file, case: c } of cases) {
  const problems = caseProblems(c, file);
  check(`${file} is whole`, problems.length === 0);
  if (problems.length) show(problems);
  check(
    `${file} has what it is graded on, and max_turns`,
    ((c.kind ?? "build") !== "build" || (c.success?.length > 0 && c.must_not?.length > 0)) &&
      ((c.kind ?? "build") === "build" || !!c.expect) &&
      Number.isInteger(c.max_turns)
  );
  const leaks = privateBits(JSON.stringify(c));
  check(`${file} holds no email, phone number or id`, leaks.length === 0);
  if (leaks.length) show(leaks);
}
const cleanup = cases.find((x) => x.case.id === "rto-cleanup")?.case;
check(
  "rto-cleanup starts from a section with RTO three ways and a note",
  ["rto", "rto_status", "is_rto", "rto_note"].every((f) =>
    cleanup?.before?.[0]?.newSchema?.columns?.some((col) => col.field === f)
  )
);
check(
  "and that section is itself a workaround sign, so a cleanup can be seen to clear it",
  workaroundSigns([{ nav_label: "Shipments", columns: cleanup.before[0].newSchema.columns }], []).length === 1
);

console.log("\na broken case is caught");
const good = cases[0].case;
const broken = (over) => caseProblems({ ...good, ...over }, `${good.id}.json`);
check(
  "no must_not",
  broken({ must_not: [] }).some((p) => p.startsWith("must_not"))
);
check(
  "no max_turns",
  broken({ max_turns: undefined }).some((p) => p.startsWith("max_turns"))
);
check(
  "a language of its own",
  broken({ language: "hindi" }).some((p) => p.startsWith("language"))
);
check(
  "a key nobody reads",
  broken({ notes: "x" }).some((p) => p.includes('"notes"'))
);
check("named apart from its file", caseProblems(good, "other.json").length === 1);
check(
  "the common criteria left out",
  broken({ success: good.success.filter((s) => s !== COMMON_SUCCESS[0]) }).length === 1 &&
    broken({ must_not: good.must_not.filter((s) => s !== COMMON_MUST_NOT[0]) }).length === 1
);
check(
  "a fact with no answer",
  broken({ facts: { "the window": "" } }).some((p) => p.startsWith("facts"))
);

console.log("\nwhat counts as private");
check("an email", privateBits("write to someone@example.com").length === 1);
check("a phone number, spaced or not", privateBits("+91 98100 00099 or 9810000099").length === 2);
check("an id", privateBits("row 3f2b8c1e-1a2b-4c3d-9e8f-0a1b2c3d4e5f").length === 1);
check("not an order number, an AWB or a date", privateBits("A-101 AWB0001 2026-10-03 #1042").length === 0);

console.log("\nthe grader's answer");
const success = ["RTO is one tick", "there is a filter for RTO"];
const mustNot = ["a separate RTO status field", "jargon"];
const material = `5. Luke: I'll keep RTO as one tick — ticked when the parcel comes back,\n left blank otherwise.\nSection "Shipments"\n  Filters: RTO (Yes)`;
const fenced =
  "```json\n" +
  JSON.stringify({
    criteria: [
      { n: 1, met: true, evidence: "keep RTO as one tick ... left blank otherwise" },
      { n: 2, met: true, evidence: "Filters: RTO (Yes)" },
    ],
    must_not: [
      { n: 1, hit: false, evidence: "" },
      { n: 2, hit: false, evidence: "" },
    ],
    scores: { discussed: 4, plain: "5", better_idea: 3, simplest: 4 },
  }) +
  "\n```";
const g = parseGrade(fenced, success, mustNot, material);
check("a fenced answer is read", g.ok && g.criteria.every((x) => x.met));
check("a quote across a line break and an ellipsis is found", g.criteria[0].met);
check(
  "must-nots the grader cleared are clear",
  g.must_not.every((x) => !x.hit)
);
check("scores read as numbers", g.scores.plain === 5 && g.scores.discussed === 4);

const bad = parseGrade("Sure! Here is my verdict: everything looks great.", success, mustNot, material);
check("an answer that is not JSON meets nothing", !bad.ok && bad.criteria.every((x) => !x.met));
check(
  "and rules out nothing it must not do",
  bad.must_not.every((x) => x.hit)
);
check(
  "and scores 1 throughout",
  Object.values(bad.scores).every((s) => s === 1)
);
check("half-written JSON is not JSON", jsonOf('{"criteria": [{"n": 1, "met": tr') === null);

const unquoted = parseGrade(
  JSON.stringify({
    criteria: [
      { n: 1, met: true, evidence: "" },
      { n: 2, met: true, evidence: "there is a filter that shows RTO" },
    ],
    must_not: [{ n: 1, hit: true, evidence: "RTO status" }],
    scores: { discussed: 9, plain: 0, better_idea: "x" },
  }),
  success,
  mustNot,
  material
);
check("a yes with no quote is not met", !unquoted.criteria[0].met && /no quote/.test(unquoted.criteria[0].evidence));
check(
  "a yes quoting words that are not there is not met",
  !unquoted.criteria[1].met && /not in the material/.test(unquoted.criteria[1].evidence)
);
check(
  "a must-not it hit is hit, and one it did not answer is hit too",
  unquoted.must_not.every((x) => x.hit)
);
check(
  "a score outside 1 to 5, or none, is a 1",
  Object.values(unquoted.scores).every((s) => s === 1)
);
check(
  "a quote is matched whatever its case, quotes or spacing",
  quoteFound("“KEEP rto as   one tick”", material) && !quoteFound("ab", material)
);
// As a grader really writes it (3 Oct): a speaker, single quotes with quotes
// inside, a remark after. The quoted words are what must be found.
const said = "Luke: 'har COD order jo abhi PENDING hai, usko ek 'to call' list mein daal denge'";
const chat =
  "luke: Samajh gaya — har COD order jo abhi PENDING hai, usko ek 'to call' list mein daal denge. Aapki team";
check("a quote with the speaker's name and quotes inside is found", quoteFound(said, chat));
check(
  "a quote beside a remark is found by its quoted words",
  quoteFound("Luke asked 'Want me to build it?' twice (turns 2 and 4)", "...ya alag list? Want me to build it?")
);
check(
  "and words never said are still not",
  !quoteFound("Luke: 'every COD order goes to a call list automatically'", chat)
);

console.log("\nthe simulated owner's answer");
check("fenced JSON", parseSim('```json\n{"agree": true, "pushback": false, "say": "haan"}\n```').agree === true);
const prose = parseSim("Haan theek hai, bana do");
check("words that are not JSON are words, not a yes", !prose.agree && prose.say === "Haan theek hai, bana do");

console.log("\nthe workaround signs (0175)");
const col = (field, type, more = {}) => ({ field, label: field, type, ...more });
const tangle = workaroundSigns(
  [
    {
      nav_label: "Shipments",
      columns: [
        col("rto", "boolean"),
        col("rto_status", "badge"),
        col("is_rto", "boolean", { hidden: true }),
        col("rto_note", "longtext"),
      ],
    },
  ],
  []
);
check("three yes/no or status fields sharing a word, a hidden one too", tangle.length === 1 && /"rto"/.test(tangle[0]));
check(
  "two are not three, and a note is not a yes/no",
  workaroundSigns(
    [{ nav_label: "S", columns: [col("rto", "boolean"), col("rto_note", "longtext"), col("is_rto", "boolean")] }],
    []
  ).length === 0
);
check(
  "a word that says nothing (status) is not a fact kept three ways",
  workaroundSigns(
    [
      {
        nav_label: "Orders",
        columns: [col("call_status", "badge"), col("pay_status", "badge"), col("ship_status", "dropdown")],
      },
    ],
    []
  ).length === 0
);
const rule = (trigger, actions, enabled = true) => ({ name: "r", enabled, definition: { trigger, actions } });
const setAll = [{ type: "set_fields", target: { self: true }, set: { rto: { const: false } } }];
check(
  "a schedule setting fields with no condition",
  workaroundSigns([], [rule({ type: "schedule", every: "hourly" }, setAll)]).length === 1
);
check(
  "not with a condition, not when off, not on a row's own save",
  workaroundSigns(
    [],
    [
      rule({ type: "schedule", every: "daily", when: { op: "lt", args: [{ field: "stock" }, { const: 5 }] } }, setAll),
      rule({ type: "schedule", every: "hourly" }, setAll, false),
      rule({ type: "record_created" }, setAll),
      rule({ type: "schedule", every: "daily" }, [{ type: "alert", title: "Low stock" }]),
    ]
  ).length === 0
);
const written = { type: "custom", title: "Returns", html: "<div class='wl-page'></div>" };
check(
  "a written screen over rows a table shows, as the view or as a tab",
  workaroundSigns([{ nav_label: "Returns", columns: [col("order", "text")], features: { view: written } }], [])
    .length === 1 &&
    workaroundSigns(
      [
        {
          nav_label: "Returns",
          columns: [col("order", "text")],
          features: { view: { type: "table" }, tabs: [written] },
        },
      ],
      []
    ).length === 1
);
check(
  "a table is not one",
  workaroundSigns(
    [{ nav_label: "Returns", columns: [col("order", "text")], features: { view: { type: "table" } } }],
    []
  ).length === 0
);
check(
  "the build is described with what a grader would quote",
  /Fields: rto \[rto\] \(boolean\)/.test(
    describeBuild([{ id: "m", nav_label: "Shipments", columns: [col("rto", "boolean")] }], [])
  ) &&
    /Rule "r" on Shipments: every hourly/.test(
      describeBuild(
        [{ id: "m", nav_label: "Shipments" }],
        [{ ...rule({ type: "schedule", every: "hourly" }, setAll), module_id: "m" }]
      )
    )
);

console.log("\njargon the owner reads");
check(
  "a type and a field's own name",
  jargonIn("Main ek boolean field rto_status bana dunga").join() === "boolean,rto_status"
);
check(
  "plain words are plain",
  jargonIn("Ek RTO tick, aur ek filter jo sirf RTO wale dikhaye. Bana doon?").length === 0
);
const asked = {
  type: "clarify",
  message: "Do sawal:",
  questions: [{ question: "Khali ka matlab?", suggestions: ["RTO nahi hua", "set_fields"] }],
};
check("questions and their suggestions are read too", jargonIn(ownerText(asked)).join() === "set_fields");
check(
  "a design is shown to the owner as lines",
  /\[A design, with a Build button:\]\n- NEW_MODULE "Shipments"/.test(
    replyText({
      type: "plans",
      plans: [{ changeType: "NEW_MODULE", newModule: { nav_label: "Shipments" }, explanation: "x" }],
    })
  )
);

{
  const card = replyText({
    type: "plans",
    plans: [
      {
        changeType: "NEW_MODULE",
        newModule: { nav_label: "Shipments" },
        newSchema: { columns: [{ field: "is_rto", label: "RTO", type: "boolean" }] },
        explanation: "x",
      },
    ],
  });
  check(
    "the card shows a field by its label, as the app does (4 Oct)",
    card.includes("RTO (boolean)") && !card.includes("[is_rto]")
  );
}

check(
  "a turn's steps are kept as short lines (4 Oct)",
  [
    { step: "road", road: "design" },
    { step: "model", attempt: 3, of: 4 },
    { step: "critic", verdict: "redo", missing: 2 },
    { step: "ux", verdict: "redo", how: "screenshot" },
    { step: "data", problems: 1, notes: 0 },
  ]
    .map(stepLine)
    .join(" | ") === "road design | model 3/4 | critic redo 2 missing | ux redo screenshot | data 1 problems"
);

console.log("\nthe cap");
const m = capMeter(1);
let refused = null;
try {
  m.before(0.4, "a");
  m.add(0.4);
  m.before(0.6, "b");
  m.add(0.5);
  m.before(0.2, "c");
} catch (e) {
  refused = e;
}
check("it lets a call through that would land on the cap", m.spent === 0.9);
check(
  "and stops one that could pass it, before it is made",
  refused instanceof CapReached && /before c/.test(refused.message)
);
// A run on a fake meter: every turn costs what it was counted at, and the run never passes its cap.
const run = capMeter(1.5);
const costs = [];
let turns = 0;
try {
  for (;;) {
    const estimate = lukeEstimate(costs);
    run.before(estimate + 0.02, "a turn");
    run.add(estimate);
    costs.push(estimate);
    turns++;
  }
} catch (e) {
  check("a run of turns stops cleanly", e instanceof CapReached);
}
check("having spent no more than the cap", run.spent <= 1.5 && turns === 4);
check("a turn is counted at the default before any is measured", lukeEstimate([]) === LUKE_TURN_USD);
check("and at the case's average once that is dearer", lukeEstimate([0.1, 0.9]) === 0.5);
check("a model with no price cannot be capped", estimateUsd("claude-unknown-9", 1000, 100) === Infinity);
check(
  "a call is priced from what is sent and the reply it is counted at",
  Math.abs(estimateUsd("claude-haiku-4-5", 35_000, 2000) - (10_000 * 1.25 + 2000 * 5) / 1e6) < 1e-12
);

console.log("\nthe arguments");
check("a label is needed", !!parseArgs(["--max-usd", "1"]).error);
check("and a cap, inside the budget", !!parseArgs(["--label", "x", "--max-usd", "11"]).error);
const parsed = parseArgs(["--label", "before", "--max-usd", "1.5", "--cases", "rto-new, low-stock"]);
check(
  "read as given",
  parsed.label === "before" &&
    parsed.maxUsd === 1.5 &&
    parsed.cases.join() === "rto-new,low-stock" &&
    !parsed.designModel
);

console.log("\nwhat a run adds up to");
const scores = (n) => ({ discussed: n, plain: n, better_idea: n, simplest: n });
const passed = {
  id: "a",
  title: "A",
  turns: 2,
  built: true,
  signs: { workarounds: [], jargon: [], proposed_first: true },
  criteria: [{ text: "x", met: true, evidence: "q" }],
  must_not: [{ text: "y", hit: false, evidence: "" }],
  scores: scores(4),
  cost: 0.31234,
  ms: 40_000,
};
const failed = {
  ...passed,
  id: "b",
  signs: { workarounds: ["Rule sets every row"], jargon: ["boolean"], proposed_first: false },
  criteria: [{ text: "x", met: false, evidence: "" }],
  scores: scores(2),
  cost: 0.2,
  ms: 21_000,
};
check("a case passes on every criterion met and nothing it must not do", casePassed(passed) && !casePassed(failed));
check("a hit fails it", !casePassed({ ...passed, must_not: [{ text: "y", hit: true, evidence: "" }] }));
check("signs: each workaround, each word, and a build with no plan first", signCount(failed) === 3);
check("no plan said and nothing built is not a sign", signCount({ ...failed, built: false }) === 2);
const s = summarise([passed, failed]);
check(
  "the summary",
  s.pass_rate === 0.5 && s.avg_scores.plain === 3 && s.signs_total === 3 && s.cost === 0.5123 && s.avg_ms === 30_500
);
if (!(s.pass_rate === 0.5 && s.cost === 0.5123)) show(s);
const none = summarise([]);
check(
  "and of nothing, zeros",
  none.pass_rate === 0 && none.cost === 0 && none.avg_ms === 0 && none.avg_scores.plain === 0
);

console.log("\nthe shops a case runs on");
const NOW = Date.UTC(2026, 9, 12, 6);
const views = { seed: viewOf(seedNodes(NOW), NOW) };
for (const [name, shop] of Object.entries(SHOPS)) {
  const nodes = shopNodes(shop, NOW);
  views[name] = viewOf(nodes, NOW);
  check(
    `${name}: every list a store has, its orders and its stock`,
    RESOURCES.every((r) => Array.isArray(nodes[r])) &&
      nodes.orders.length === shop.orders.length &&
      nodes.inventory.length === views[name].variants.length
  );
  check(
    `${name}: built the same twice on the same day`,
    JSON.stringify(shopNodes(shop, NOW)) === JSON.stringify(shopNodes(shop, NOW + 3_600_000))
  );
  check(
    `${name}: an order's age is the day it was given`,
    views[name].orders.every((o, i) => o.daysBack === shop.orders[i].daysBack)
  );
}
for (const { case: c } of cases) {
  const shop = c.shop ?? "seed";
  let x = null;
  try {
    x = expectationFor(c, views[shop]);
  } catch (e) {
    show(e.message);
  }
  const fine =
    !!x &&
    (x.answer ?? []).every((it) => (it.any ?? it.names ?? [it.re]).length > 0) &&
    (!x.effect || (x.effect.count > 0 && x.effect.labels.length > 0)) &&
    (!x.exercise || x.exercise.then.labels.length > 0);
  check(`${c.id}: what it expects is worked out from its shop`, fine);
}
check(
  "a window ignored would show: the top size over all time is not the month's",
  (() => {
    const all = new Map();
    for (const o of views.fashion.orders.filter((o) => !o.cancelled))
      for (const l of o.lines.filter((l) => l.type === "Tee")) all.set(l.variant, (all.get(l.variant) ?? 0) + l.qty);
    const allTime = [...all].toSorted((a, b) => b[1] - a[1])[0][0];
    return allTime !== "M" && EXPECT["fashion-top-size"](views.fashion).answer[0].label === "size M";
  })()
);
check(
  "and the quarter's top customer is not the one with the old big order",
  !EXPECT["wholesale-top-customers"](views.wholesale).answer[0].names.includes("Iyer Supermart")
);

console.log("\nthe numbers in what Luke said");
const nums = (t) =>
  numbersIn(t)
    .map((n) => `${n.value}${n.approx ? "~" : ""}`)
    .join(" ");
check("₹31,735 and 31735.00", nums("₹31,735 or 31735.00") === "31735 31735");
check("Indian grouping", nums("₹3,17,350") === "317350");
check("a k and a lakh, as approximate", nums("about ₹31.7k, or 1.2 lakh") === "31700~ 120000~");
const lukeSaid = "Pending COD from the last 7 days is ₹1,528 across 1 order.";
check("a number said is found", answerChecks(lukeSaid, [{ label: "due", any: [1528, 1398] }])[0].ok);
check("one not said is not", !answerChecks("It is ₹1,400.", [{ label: "due", any: [1528, 1398] }])[0].ok);
check("a count is exact", !answerChecks("about 5 of them", [{ label: "n", any: [4] }])[0].ok);
check(
  "a rounded figure with a multiplier is near enough",
  answerChecks("roughly ₹31.7k in all", [{ label: "t", any: [31735] }])[0].ok
);
check(
  "names, every one",
  answerChecks("Sharma Traders, Gupta Retail and Mehta Stores lead.", [
    { label: "top", names: ["Sharma Traders", "Gupta Retail", "Mehta Stores"] },
  ])[0].ok
);
check(
  "and one missing fails",
  !answerChecks("Sharma Traders and Gupta Retail.", [
    { label: "top", names: ["Sharma Traders", "Gupta Retail", "Mehta Stores"] },
  ])[0].ok
);
check("a pattern", answerChecks("Size M sold best, 7 pieces.", [{ label: "size", re: "\\b(M|medium)\\b" }])[0].ok);

console.log("\nwhat Luke says it can and can't do");
check("“I can't see your custom rows” is a can't", cantIn("I can't actually see your custom rows").length === 1);
check("in Hinglish too", cantIn("Main WhatsApp message nahi bhej sakta").length === 1);
check("an ordinary answer is not", cantIn("Your pending COD is ₹1,528. Want a counter for it?").length === 0);
check("capable where it can", capableCheck("Here it is.").ok && !capableCheck("I cannot read that section.").ok);
check(
  "honest where it can't",
  honestCheck("This app can't send WhatsApp messages yet, but I can list who to message.").ok &&
    !honestCheck("Done, messages sent!").ok
);

console.log("\nasked first, built once, changed in place");
check("a question first", asksFirstCheck([{ type: "answer", message: "How do claims reach you today?" }]).ok);
check(
  "a design first is not",
  !asksFirstCheck([{ type: "plans", plans: [{ changeType: "NEW_MODULE" }], message: "Shall I?" }]).ok
);
const [b2] = buildChecks(2, [], { max: 2 });
const [b3] = buildChecks(3, [], { max: 2 });
check("two builds where two are allowed, three not", b2.ok && !b3.ok);
const [rebuilt] = buildChecks(
  2,
  [{ changeType: "MODULE_DELETE" }, { changeType: "NEW_MODULE", newModule: { nav_label: "Blanks" } }],
  { edited: true }
);
const [twice] = buildChecks(
  2,
  [
    { changeType: "NEW_MODULE", newModule: { nav_label: "Blanks" } },
    { changeType: "NEW_MODULE", newModule: { nav_label: "Blanks" } },
  ],
  { edited: true }
);
const [inPlace] = buildChecks(
  2,
  [{ changeType: "NEW_MODULE", newModule: { nav_label: "Blanks" } }, { changeType: "UI_CHANGE" }],
  { edited: true }
);
check("a section deleted and made again is not an edit", !rebuilt.ok && !twice.ok && inPlace.ok);

console.log("\nthe rows a build points at");
const repeat = EXPECT["snacks-repeat-cod"](views.snacks).effect;
const orderRows = views.snacks.orders.map((o, i) => ({
  id: `r${i}`,
  order_number: o.number,
  gateway: o.cod ? "COD" : "razorpay",
  repeat_cod: repeat.labels.includes(o.number),
  note: repeat.labels.includes(o.number) ? "Repeat COD" : "",
}));
const ordersSection = (columns, rows = orderRows, stats = []) => [
  { name: "Orders", table: "orders", storeFields: new Set(["id", "order_number", "gateway"]), columns, rows, stats },
];
check(
  "a tick of the owner's on exactly those orders",
  effectCheck(ordersSection([{ field: "repeat_cod", label: "Repeat COD", type: "boolean" }]), repeat).ok
);
check(
  "or a badge, whatever it is called",
  effectCheck(ordersSection([{ field: "note", label: "Call", type: "badge" }]), repeat).ok
);
check(
  "the store's own fields never count",
  !effectCheck(ordersSection([{ field: "gateway", label: "Gateway", type: "badge" }]), {
    ...repeat,
    labels: repeat.labels,
  }).ok
);
const tooMany = orderRows.map((r) => ({ ...r, repeat_cod: r.gateway === "COD" }));
check(
  "a tick on every COD order is not it",
  !effectCheck(ordersSection([{ field: "repeat_cod", label: "Repeat COD", type: "boolean" }], tooMany), repeat).ok
);
check(
  "a counter showing how many is",
  effectCheck(ordersSection([], orderRows, [{ label: "Repeat COD", value: repeat.count }]), repeat).ok
);
check(
  "and a rule's dry run matching that many is",
  effectCheck(ordersSection([]), repeat, [{ rule: "Flag repeat COD", matched: repeat.count }]).ok
);
check("nothing at all is not", !effectCheck(ordersSection([]), repeat).ok);
const batches = EXPECT["cosmetics-expiring"]().effect;
check(
  "rows of the owner's own section, found by its name",
  effectCheck(
    [
      {
        name: "Batches",
        table: null,
        storeFields: new Set(),
        columns: [{ field: "soon", label: "Expiring soon", type: "boolean" }],
        rows: [
          { id: "1", batch_code: "VCS-2401", soon: true },
          { id: "2", batch_code: "HYA-2402", soon: true },
          { id: "3", batch_code: "SPF-2403", soon: false },
        ],
      },
    ],
    batches
  ).ok
);

console.log("\nan event rule, used");
const blank = EXPECT["cases-blank"](views.cases).exercise;
const stockRows = views.cases.variants.map((v, i) => ({
  id: `v${i}`,
  sku: v.sku,
  parent: v.type === "Printed" ? "CASE-17PM-CLR" : "",
  blank_left: v.type === "Printed" ? 50 : null,
}));
const stock = [
  {
    name: "Stock",
    table: "variants",
    storeFields: new Set(["id", "sku"]),
    columns: [
      { field: "parent", label: "Blank SKU", type: "text" },
      { field: "blank_left", label: "Blank count", type: "number" },
    ],
    rows: stockRows,
  },
];
check("the designs show the blank's count once it is set", valuesCheck(stock, blank.then).ok);
check(
  "and not before",
  !valuesCheck([{ ...stock[0], rows: stockRows.map((r) => ({ ...r, blank_left: null })) }], blank.then).ok
);
check(
  "the field that ties a design to its blank is found by its words",
  pickColumn(stock[0].columns, blank.steps[0].tag.field)?.field === "parent"
);
check(
  "and the count's, not the one already taken",
  pickColumn(stock[0].columns, "blank|count", new Set(["parent"]))?.field === "blank_left"
);

console.log("\nthe checks a case asks for");
const qCase = cases.find((x) => x.case.id === "q-cod-pending").case;
const qx = expectationFor(qCase, views.seed);
const due = qx.answer[0].any[0];
const qChecks = outcomeChecks(qCase, qx, {
  replies: [{ type: "answer", message: `₹${due.toLocaleString("en-IN")} is still to collect.` }],
  builds: 0,
  builtPlans: [],
});
check(
  "a question: its number, and no can't",
  qChecks.map((x) => x.name).join() === "answer: COD still to collect from the last 7 days,capable" &&
    qChecks.every((x) => x.ok)
);
const lCase = cases.find((x) => x.case.id === "l-whatsapp").case;
check(
  "an ask the platform can't do: a plain no is what passes",
  outcomeChecks(
    lCase,
    {},
    { replies: [{ type: "answer", message: "I can't send WhatsApp messages from here." }], builds: 0, builtPlans: [] }
  )[0].ok
);
const scored = {
  criteria: [{ text: "x", met: true, evidence: "" }],
  must_not: [{ text: "y", hit: false, evidence: "" }],
  checks: [
    { name: "a", ok: true, detail: "" },
    { name: "b", ok: false, detail: "" },
  ],
};
check("a score out of 10 is the share of everything graded", scoreOf(scored) === 7.5);
check("a failed check fails the case", !casePassed(scored) && casePassed({ ...scored, checks: [scored.checks[0]] }));
check(
  "a question graded by code alone can pass",
  casePassed({ criteria: [], must_not: [], checks: [{ name: "a", ok: true, detail: "" }] })
);

console.log("\nthe conversation, played without a model");
const reply = (r) => ({ ...r, message: r.message ?? "" });
const play = async (c, script, owner = () => ({ agree: true, pushback: false, say: "" })) => {
  const sent = [];
  const built = [];
  let i = 0;
  const out = await converse(c, {
    chat: async (message) => {
      sent.push(message);
      return {
        reply: reply(script[i++]),
        conversationId: "t1",
        answerId: `a${i}`,
        ms: 1000,
        usd: 0.1,
        trace: { repairs: 0, refused: [], steps: [] },
      };
    },
    build: async (plans) => {
      built.push(plans.length);
      return { ok: true, errors: [] };
    },
    sim: async () => ({ said: owner(), usd: 0.001 }),
  });
  return { out, sent, built };
};
const design = (approved) => ({
  type: "plans",
  approved,
  plans: [{ changeType: "NEW_MODULE", newModule: { nav_label: "Calls" } }],
});
const fCase = cases.find((x) => x.case.id === "f-cod-callers").case;
const f = await play(fCase, [
  { type: "answer", kind: "proposal", message: "Main ek Calls list banaunga. Bana du?" },
  design(true),
  { type: "plans", approved: true, plans: [{ changeType: "FIELD_ADD" }] },
]);
check(
  "said in words, built on the yes, then the follow-up said and built",
  f.out.builds === 2 && f.sent[1] === "haan bana do" && f.sent[2] === fCase.follow_ups[0] && f.out.proposedFirst
);
check("and it stops when the follow-ups are said", f.sent.length === 3 && f.out.lines.at(-1).text === "Built.");
const q = await play(qCase, [
  { type: "answer", message: "₹1,528 is pending." },
  { type: "answer", message: "never asked" },
]);
check("a question ends when it is answered, with no second turn paid for", q.sent.length === 1);
const askedBack = await play(
  qCase,
  [
    { type: "answer", message: "Which 7 days?", questions: [{ question: "Which 7 days?" }] },
    { type: "answer", message: "₹1,528." },
  ],
  () => ({ agree: false, pushback: false, say: "aaj ko mila ke" })
);
check(
  "unless Luke asks back: then the owner answers and Luke answers",
  askedBack.sent.length === 2 && askedBack.sent[1] === "aaj ko mila ke"
);
const kept = { lines: [], trace: [] };
let stoppedAt = null;
try {
  await converse(qCase, {
    ...kept,
    turn: (n) => {
      if (n === 2) throw new CapReached("the cap");
    },
    chat: async () => ({
      reply: { type: "answer", message: "Which week?", questions: [{ question: "Which week?" }] },
      conversationId: "t",
      answerId: "a",
      ms: 1,
      usd: 0.1,
      trace: { repairs: 0, refused: [], steps: [] },
    }),
    build: async () => ({ ok: true, errors: [] }),
    sim: async () => ({ said: { agree: false, pushback: false, say: "this week" }, usd: 0 }),
  });
} catch (e) {
  stoppedAt = e;
}
check(
  "a run the cap stops keeps what was said, in the caller's own lines",
  stoppedAt instanceof CapReached && kept.lines.length === 2 && kept.trace.length === 1
);

console.log("\nwhich cases a run is, and dates in a case");
const plain = cases.map((x) => x.case);
const smoke = selectCases(plain, { set: "smoke" });
check(
  "the smoke set is six, across the kinds",
  smoke.length === 6 && new Set(smoke.map((c) => c.kind ?? "build")).size >= 4
);
const a = selectCases(plain, { set: "full-a" });
const b = selectCases(plain, { set: "full-b" });
check("the two halves are every case once", a.length + b.length === plain.length && a.every((c) => !b.includes(c)));
check("named cases win", selectCases(plain, { cases: ["q-owed"] })[0].id === "q-owed");
check(
  "{{days:+45}} is that day, in India",
  fillDates({ x: ["{{days:+45}}"] }, Date.UTC(2026, 9, 12, 20)).x[0] === "2026-11-27"
);
check(
  "the arguments take a set",
  parseArgs(["--label", "smoke", "--max-usd", "2.5", "--set", "smoke"]).set === "smoke"
);
check(
  "but not a set and names at once",
  !!parseArgs(["--label", "x", "--max-usd", "1", "--set", "smoke", "--cases", "q-owed"]).error
);

console.log("\nwhere a run is written");
check(
  "named by its UTC minute and label",
  runFileName(new Date("2026-10-03T21:07:00Z"), "before") === "20261003-2107-before.json"
);
check("the page's module with no runs", /RUN_FILES: Record<string, EvalRun> = \{\};/.test(runModule([])));
const two = runModule(["a.json", "b.json"]);
check(
  "and with two, each imported by name",
  two.includes('import r1 from "./b.json";') && two.includes('"a.json": r0 as unknown as EvalRun,')
);

console.log(
  fails.length === 0 ? "\nthe eval harness reads, grades, counts and stops as it says" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
