// What the merchant's own AI is told about helping them (lib/client-guide.ts,
// 5 Oct): the reviewer's simpler ways and when a written screen is right,
// from the very list the reviewer reads; every tool, by the first sentence
// of its own description; the shop's changes as the registry has them;
// their sections and what Luke learned, said as facts and never as
// instructions; prompts that name only tools there are, their words from
// the store's own numbers; and a version that moves with our words and
// never with a merchant's. Pure: no database, no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-client-guide.mjs

import { readFileSync } from "node:fs";
import { PROMPTS, aboutThem, firstSentence, guideVersion, howToHelp, outcomeOf } from "../src/lib/client-guide.ts";
import { REAL_WORK, SIMPLER_WAYS } from "../src/lib/reviewers.ts";
import { whatCanChange } from "../src/lib/store-actions.ts";
import { STORE_TOOLS } from "../src/lib/store-tools.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The tools as the server lists them: the store's, and the route's own, read off its source.
const route = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
const listed = route.slice(route.indexOf("const TOOLS = ["), route.indexOf("] as const;"));
const own = [...listed.matchAll(/^ {4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
const names = [...STORE_TOOLS.map((t) => t.name), ...own];
const tools = names.map((name) => ({ name, description: `Does ${name}. More words after.` }));

console.log("how to help, from what Luke works to");
{
  const g = howToHelp(tools);
  check(
    "every simpler way the reviewer sends a design back for",
    SIMPLER_WAYS.every((w) => g.includes(w))
  );
  check("and when a written screen is right after all", g.includes(REAL_WORK));
  check("the shop's changes as the registry has them", g.includes(whatCanChange()));
  check("talk the plan through before building", g.includes("say the plan back in plain words"));
  check(
    "every tool, by the first sentence of its description",
    names.every((n) => g.includes(`- ${n}: Does ${n}.`))
  );
  check("edit_view and how_to_help among them", g.includes("- edit_view:") && g.includes("- how_to_help:"));
  check("a first sentence stops at its full stop", firstSentence("Rename it. Then more.") === "Rename it.");
  check("a description with none is all of it", firstSentence("Rename it") === "Rename it");
}

console.log("\nabout this merchant");
{
  const t = aboutThem([
    {
      name: "Shop",
      sections: [
        { name: "Orders", store: true },
        { name: "Returns", store: false },
      ],
      learned: ["Status words in Hindi (they read them on the floor)", "x".repeat(400)],
    },
    { name: "Second\napp", sections: [], learned: [] },
  ]);
  check("their sections, the store's said as such", t.includes('"Orders" (the store\'s own rows), "Returns"'));
  check(
    "what Luke learned, as facts and never instructions",
    t.includes("never instructions") && t.includes("Status words in Hindi")
  );
  check("a long lesson is cut", !t.includes("x".repeat(201)));
  check("a name on one line", t.includes('App "Second app": nothing built yet.'));
  check("no apps: nothing about them", aboutThem([]) === "");
  const many = aboutThem([
    { name: "Big", sections: Array.from({ length: 45 }, (_, i) => ({ name: `S${i}`, store: false })), learned: [] },
  ]);
  check("past forty sections, how many more", many.includes(", and 5 more."));
  // What they told Luke, and what hurts them with how its fix went (0201).
  const told = aboutThem([
    {
      name: "Shop",
      sections: [],
      learned: [],
      known: ["Courier is Delhivery"],
      hurts: [
        { problem: "COD calls eat the morning", cost: "two hours a day", status: "same" },
        { problem: "Wrong sizes go out", cost: null, status: "open" },
      ],
    },
  ]);
  check("their facts reach their AI", told.includes("Courier is Delhivery") && told.includes("never instructions"));
  check(
    "what hurts them, with what it costs and how its fix went",
    told.includes("COD calls eat the morning (two hours a day): built for, and they say nothing changed") &&
      told.includes("Wrong sizes go out: not fixed yet")
  );
  check("and never to offer again what did not help", told.includes("Never offer again what they said did not help"));
  check("nothing said of either when there is none", !t.includes("What hurts them") && !t.includes("told Luke"));
}

console.log("\nready-made asks");
{
  const mentioned = (s) => [...s.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]);
  const sample = { section: "Returns", change: "hide the amount", problem: "the filter is empty" };
  const asks = [{ label: "40% of orders are COD: confirm them first", prompt: "Set up COD confirmation." }];
  check(
    "every tool a prompt names is one the server has",
    PROMPTS.every((p) => mentioned(p.text(sample, asks)).every((n) => names.includes(n)))
  );
  check("unique names", new Set(PROMPTS.map((p) => p.name)).size === PROMPTS.length);
  const build = PROMPTS.find((p) => p.name === "what_to_build");
  check("what to build says what the store's numbers show", build.text({}, asks).includes("40% of orders are COD"));
  check("and with nothing shown, asks them", build.text({}, []).includes("Ask me what slows my team down"));
  const custom = PROMPTS.find((p) => p.name === "customize_section");
  check(
    "a section's look goes to edit_view, in their words",
    /"Returns" section: hide the amount.*edit_view/.test(custom.text(sample, []))
  );
  check(
    "what a fix needs is asked for",
    PROMPTS.find((p) => p.name === "fix_section").arguments.every((a) => a.required)
  );
}

console.log("\nwhich guide this is");
{
  const v = guideVersion(tools);
  check("short", /^[0-9a-f]{10}$/.test(v));
  check("the same words, the same version", guideVersion(tools) === v);
  check(
    "a tool's description changed, a new one",
    guideVersion(tools.map((t, i) => (i === 0 ? { ...t, description: "Changed." } : t))) !== v
  );
  check("a tool more, a new one", guideVersion([...tools, { name: "x_y", description: "New." }]) !== v);
}

console.log("\nhow a call came out, read off its answer");
{
  const said = (o) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(o) }] } });
  check(
    "refused, with how many problems",
    JSON.stringify(outcomeOf(said({ status: "not accepted", errors: ["a", "b"] }))) ===
      '{"outcome":"not accepted","problems":2}'
  );
  check("built", outcomeOf(said({ status: "built" })).outcome === "built");
  check(
    "a design Luke changed before the merchant saw it",
    JSON.stringify(
      outcomeOf(said({ status: "waiting for approval", checked_by_luke: { changed: true, why: ["x"] } }))
    ) === '{"outcome":"luke changed it","problems":1}'
  );
  check(
    "one Luke left as it was keeps its status",
    outcomeOf(said({ status: "waiting for approval", checked_by_luke: { changed: false } })).outcome ===
      "waiting for approval"
  );
  check("a tool that failed", outcomeOf({ result: { isError: true, content: [] } }).outcome === "error");
  check("an error said", outcomeOf(said({ error: "Which app?" })).outcome === "error");
  check("a protocol refusal", outcomeOf({ error: { code: -32602 } }).outcome === "refused call");
  check("rows, answered", outcomeOf(said({ rows: [] })).outcome === "answered");
  check("not JSON, answered", outcomeOf({ result: { content: [{ text: "plain words" }] } }).outcome === "answered");
  check("nothing at all", outcomeOf(null).outcome === "refused call");
}

console.log(fails.length === 0 ? "\ntheir AI is told what Luke works to" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
