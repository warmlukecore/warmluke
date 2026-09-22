// Which hero a visitor sees, and whether the page can ever show none.
//
// This is the one piece of the landing page where a wrong branch is
// invisible: the page still renders, the visitor still reads a
// headline, and the experiment quietly measures the wrong thing. The
// brief's own QA list is mostly these cases — an explicit variant, a
// campaign, a malformed parameter, and a reload that must not change
// what somebody is already looking at.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-landing.mjs

import {
  HEROES,
  DEFAULT_HERO,
  CAMPAIGN_HEROES,
  assignHero,
  heroById,
  resolveHero,
  cycleCss,
  headlineParts,
} from "../src/lib/landing.ts";
import { readFileSync } from "node:fs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the list itself");
check("every hero has a headline", HEROES.every((h) => h.headline?.length > 0));
check("and something to click", HEROES.every((h) => h.cta?.length > 0));
check("ids are unique", new Set(HEROES.map((h) => h.id)).size === HEROES.length);
check("the default is one of them", !!heroById(DEFAULT_HERO));
check(
  "the live weights add up to a hundred",
  HEROES.filter((h) => h.live).reduce((n, h) => n + h.weight, 0) === 100
);
check(
  "every campaign points at a hero that exists",
  Object.values(CAMPAIGN_HEROES).every((id) => !!heroById(id))
);
// The brief is explicit that there is no Start Free, Create Account or
// Sign Up anywhere: the only thing being asked for is a demo.
check(
  "nothing asks anyone to sign up",
  HEROES.every((h) => !/sign ?up|start free|create account/i.test(`${h.cta} ${h.secondary ?? ""}`))
);

console.log("\nwhich one a visitor gets");
check("an explicit variant wins", resolveHero({ wlVariant: "apps" }).hero.id === "apps");
check(
  "and beats the campaign it arrived with",
  resolveHero({ wlVariant: "apps", utmCampaign: "chatgpt" }).hero.id === "apps"
);
check(
  "a campaign continues into its hero",
  resolveHero({ utmCampaign: "replace_apps" }).hero.id === "apps"
);
check(
  "campaign names are matched whatever their case",
  resolveHero({ utmCampaign: "Replace_Apps" }).hero.id === "apps"
);

console.log("\nand nothing a stranger types can break it");
for (const junk of ["asdf123", "", "   ", "../../etc/passwd", "<script>", "operator "]) {
  const got = resolveHero({ wlVariant: junk, random: 0.5 });
  check(
    `"${junk.slice(0, 16)}" still produces a hero`,
    typeof got.hero.headline === "string" && got.hero.headline.length > 0
  );
}
check(
  "and a junk variant falls through to the campaign",
  resolveHero({ wlVariant: "asdf123", utmCampaign: "chatgpt" }).hero.id === "chatgpt"
);

console.log("\nand it does not move under them");
check(
  "a reload keeps what they were given",
  resolveHero({ assigned: "problem", random: 0 }).hero.id === "problem"
);
check(
  "but an ad still overrides it",
  resolveHero({ assigned: "problem", wlVariant: "chatgpt" }).hero.id === "chatgpt"
);
check(
  "a campaign overrides it too",
  resolveHero({ assigned: "problem", utmCampaign: "replace_apps" }).hero.id === "apps"
);
check(
  "an assignment that no longer exists is not honoured",
  resolveHero({ assigned: "retired-last-month", random: 0 }).hero.id === "operator"
);

console.log("\nand the roll covers the whole range");
check("the bottom of the roll", assignHero(0).id === "operator");
check("the top of the roll", assignHero(0.999999).id === "problem");
check(
  "a variant that is not live is never assigned",
  Array.from({ length: 400 }, (_, i) => assignHero(i / 400).id).every(
    (id) => heroById(id)?.live === true
  )
);
// Weighted evenly today, so a big sweep should land near a quarter
// each. This is what catches an off-by-one in the walk.
{
  const seen = new Map();
  for (let i = 0; i < 10000; i++) {
    const id = assignHero(i / 10000).id;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const live = HEROES.filter((h) => h.live);
  check(
    "each live hero is actually reachable",
    live.every((h) => (seen.get(h.id) ?? 0) > 0)
  );
  check(
    "and none of them takes more than its share",
    live.every((h) => Math.abs((seen.get(h.id) ?? 0) / 10000 - h.weight / 100) < 0.02)
  );
}

console.log("\nand the marked words are really in the headline");
// Both failures are silent. An emphasis or a cycling word that does
// not occur still renders a perfectly good headline — just flat, or
// just still — and the design quietly loses the thing it was built
// around.
const whole = (h) => headlineParts(h).map((p) => p.text).join("");
for (const h of HEROES) {
  check(`${h.id}: not a word is lost in the split`, whole(h) === h.headline);
  const parts = headlineParts(h);
  if (h.emphasis) {
    check(`${h.id}: "${h.emphasis}" is set in italic`, parts.some((p) => p.kind === "italic" && p.text === h.emphasis));
  }
  if (h.cycle) {
    check(`${h.id}: "${h.cycle.word}" is the word that cycles`, parts.some((p) => p.kind === "cycle" && p.text === h.cycle.word));
    // The headline's own word has to lead, or the line a crawler
    // reads is not the line the variant claims to be testing.
    check(`${h.id}: and the list starts with it`, h.cycle.through[0] === h.cycle.word);
    check(`${h.id}: with something to cycle to`, h.cycle.through.length > 1);
    check(`${h.id}: and no name twice`, new Set(h.cycle.through).size === h.cycle.through.length);
  }
}

const plain = { id: "x", weight: 0, live: false, headline: "Just a line.", sub: "", cta: "" };
check("a variant with no markers renders whole", headlineParts(plain).map((p) => p.text).join("") === "Just a line.");
check("and is one plain piece", headlineParts(plain).length === 1);
const wrong = { ...plain, emphasis: "nowhere" };
check("a marker that is not there loses no words", headlineParts(wrong).map((p) => p.text).join("") === "Just a line.");
check("and marks nothing", headlineParts(wrong).every((p) => p.kind === "plain"));
const both = { ...plain, headline: "One two three.", emphasis: "three", cycle: { word: "One", through: ["One", "Two"] } };
const ordered = headlineParts(both);
check("two markers come back in reading order", ordered.map((p) => p.kind).join(",") === "cycle,plain,italic,plain");
check("and still spell the headline", ordered.map((p) => p.text).join("") === "One two three.");
// Overlapping markers must not duplicate the text between them.
const clash = { ...plain, headline: "One two three.", emphasis: "One two", cycle: { word: "two", through: ["two", "three"] } };
check("overlapping markers do not duplicate a word", headlineParts(clash).map((p) => p.text).join("") === "One two three.");

console.log("\nand the animation is cut for however many names there are");
// Keyframes written for five and handed six shows one name twice
// and one never — the reason this is generated rather than typed.
check("one name is not an animation", cycleCss(1) === null);
check("none at all is not either", cycleCss(0) === null);
for (const n of [2, 3, 5, 9]) {
  const css = cycleCss(n);
  check(`${n} names: the loop is ${n} slots long`, css.includes(`${(n * 2.2).toFixed(2)}s`));
  // Every percentage it emits has to be a real one.
  const pcs = [...css.matchAll(/([0-9.]+)%/g)].map((m) => Number(m[1]));
  check(`${n} names: every keyframe sits inside the loop`, pcs.every((v) => v >= 0 && v <= 100));
  check(`${n} names: they only ever move forwards`, pcs.every((v, i) => i === 0 || v >= pcs[i - 1]));
  check(`${n} names: reduced motion stops it`, /prefers-reduced-motion/.test(css));
}

console.log("\nand no long dash reached the copy");
// Asked for by name: the em dash reads as machine-written, and one
// slipped back into new copy within an hour of the last sweep. The
// pages a visitor meets before signing in are all here, comments
// stripped first so the reasoning above a line can say what it likes.
const COPY = [
  "src/app/page.tsx",
  "src/lib/landing.ts",
  "src/components/Landing.tsx",
  "src/app/terms/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/login/page.tsx",
  "src/app/signup/page.tsx",
  "src/app/forgot/page.tsx",
  "src/app/reset/page.tsx",
];
for (const f of COPY) {
  const code = readFileSync(new URL(`../${f}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  check(`${f.replace("src/", "")} has none`, !/[\u2013\u2014]/.test(code));
}

console.log("\nand every file those pages ask for is really in public/");
// The whole class of failure a folder tidy-up causes: the path
// still parses, the build still passes, and the mark is a broken
// image on the page a merchant signs in from. Nine references to
// two files, and nothing but this connects them.
for (const f of COPY) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const [, ref] of src.matchAll(/src="(\/[^"]+\.[a-z0-9]{2,5})"/g)) {
    let there = true;
    try {
      readFileSync(new URL(`../public${ref}`, import.meta.url));
    } catch {
      there = false;
    }
    check(`${ref} (${f.split("/").slice(-2).join("/")})`, there);
  }
}

console.log(fails.length === 0 ? "\nthe right hero, every time" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
