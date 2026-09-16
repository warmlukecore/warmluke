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
} from "../src/lib/landing.ts";

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

console.log(fails.length === 0 ? "\nthe right hero, every time" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
