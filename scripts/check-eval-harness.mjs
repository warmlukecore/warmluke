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
  workaroundSigns,
} from "./eval-luke.mjs";
import { casePassed, signCount, summarise } from "../src/lib/eval-report.ts";

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
  "eight cases, the ones asked for",
  [
    "cod-confirm",
    "low-stock",
    "repeat-customers",
    "repeat-orders",
    "return-reasons",
    "returns-screen",
    "rto-cleanup",
    "rto-new",
  ].join() === ids.join()
);
for (const { file, case: c } of cases) {
  const problems = caseProblems(c, file);
  check(`${file} is whole`, problems.length === 0);
  if (problems.length) show(problems);
  check(
    `${file} has success, must_not and max_turns`,
    c.success?.length > 0 && c.must_not?.length > 0 && Number.isInteger(c.max_turns)
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
