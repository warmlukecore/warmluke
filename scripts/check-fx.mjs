// Shopify money stays in the currency Shopify recorded.
//
// This used to test a latest-rate converter that REPLACED the shop's
// amounts. A current rate applied to historical orders produces
// plausible numbers that cannot reconcile to Shopify, so the converted
// figure is no longer the amount — it is a smaller line underneath,
// marked as an estimate, and the recorded amount is what is shown.
//
// The two properties that matter, and that this file exists to keep:
// money() never converts, and the estimate only appears where it can
// actually be true.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-fx.mjs

import { existsSync, readFileSync } from "node:fs";
import { makeFormatting } from "../src/lib/money.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("source currencies stay attached to their amounts");
{
  const fmt = makeFormatting("en-IN", "INR");
  check("project money still uses the project default", fmt.money(100).includes("₹"));
  check(
    "an imported dollar amount stays a dollar amount",
    fmt.money(100, "USD").includes("$") && fmt.money(100, "USD").includes("100")
  );
  check(
    "formatting never changes the numeric amount",
    fmt.money(95.96, "USD").includes("95.96")
  );
}

console.log("\nthe estimate is an estimate, and only where it can be true");
{
  const rate = { rate: 95.96, from: "USD", asOf: "2026-09-16" };
  const fmt = makeFormatting("en-IN", "INR", rate);

  // The whole point: the amount shown is still the shop's.
  check("the recorded amount is untouched", fmt.money(100, "USD").includes("100"));
  check("and still wears its own sign", fmt.money(100, "USD").includes("$"));

  // 100 x 95.96 = 9,596.
  const rough = fmt.approx(100, "USD");
  check("the estimate is offered beside it", typeof rough === "string" && /9,596/.test(rough));
  check("and is marked as approximate", (rough ?? "").startsWith("≈"));
  check("in the project's money", (rough ?? "").includes("₹"));

  // Fractions convert before rounding: 100.05 x 95.96 = 9,600.798.
  check("fractions are not rounded first", /9,600\.80/.test(fmt.approx(100.05, "USD") ?? ""));

  check("a row already in the project's money gets none", fmt.approx(100, "INR") === null);
  check("nor does one with no currency of its own", fmt.approx(100) === null);
  // A USD->INR rate says nothing about a euro. This is the two-stores
  // case, and guessing here would be the whole bug in miniature.
  check("nor a currency this rate says nothing about", fmt.approx(100, "EUR") === null);

  const noRate = makeFormatting("en-IN", "INR");
  check("with no rate at all there is no second line", noRate.approx(100, "USD") === null);
  check("and the amount is unaffected", noRate.money(100, "USD").includes("100"));

  for (const bad of [{ ...rate, rate: 0 }, { ...rate, rate: -1 }, { ...rate, rate: NaN }]) {
    check(
      `a rate of ${bad.rate} is refused`,
      makeFormatting("en-IN", "INR", bad).approx(100, "USD") === null
    );
  }
}

console.log("\nand it is actually wired up");
{
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  const storeRead = readFileSync(new URL("../src/lib/store-read.ts", import.meta.url), "utf8");
  const views = readFileSync(new URL("../src/components/views.tsx", import.meta.url), "utf8");
  const ai = readFileSync(new URL("../src/lib/ai.ts", import.meta.url), "utf8");
  const renderer = readFileSync(
    new URL("../src/components/GenericRenderer.tsx", import.meta.url),
    "utf8"
  );

  // This effect was silently lost to a bad edit once before: the state
  // existed, the route existed, nothing called it, and the feature was
  // dead in a way that still rendered.
  check("something asks for a rate", /apiFetch\(`\/api\/fx/.test(shell));
  check("and does something with the answer", /setFx\(/.test(shell));
  check("only when the two currencies differ", /from === to/.test(shell));
  check(
    "the route it calls exists",
    existsSync(new URL("../src/app/api/fx/route.ts", import.meta.url))
  );
  check("the rate reaches the formatter", /approxRate=\{sectionApprox\}/.test(shell));
  check(
    "in the section and the chat preview alike",
    (shell.match(/approxRate=\{sectionApprox\}/g) ?? []).length >= 2
  );
  // The whole point of the flag: a project sitting on the untouched
  // INR default has not asked for anything, and must not be shown a
  // rupee estimate of a dollar shop.
  check(
    "and only once the owner has actually chosen a currency",
    /project\?\.currency_set_by_user === true/.test(shell)
  );
  check(
    "which is also what decides whether a rate is fetched at all",
    /from === to \|\| project\?\.currency_set_by_user !== true/.test(shell)
  );
  check(
    "and only for a store-backed section whose currency differs",
    /store\.currency !== project\?\.currency/.test(shell)
  );

  const projects = readFileSync(
    new URL("../src/app/api/projects/route.ts", import.meta.url),
    "utf8"
  );
  // Taken from the form, never inferred. Inferring it from "a currency
  // arrived in the payload" meant renaming the project switched on a
  // rupee estimate, because the form posts every field at once.
  check(
    "the choice is taken from the form, not guessed",
    /patch\.currency_set_by_user = currency_set_by_user === true/.test(projects) &&
      !/patch\.currency_set_by_user = true/.test(projects)
  );

  const settings = readFileSync(
    new URL("../src/components/ProjectSettings.tsx", import.meta.url),
    "utf8"
  );
  // A project nobody has touched used to show "India — ₹" as though it
  // had been picked, with no way back to not having picked.
  check(
    "the dropdown offers not choosing at all",
    /<option value="default">/.test(settings)
  );
  check(
    "and it is what an untouched project shows",
    /value=\{chose \? `\$\{locale\}\|\$\{currency\}` : "default"\}/.test(settings)
  );
  check("the form sends the choice with every save", /currency_set_by_user: chose/.test(settings));

  check("orders keep their recorded currency", /currency:\s*r\.currency/.test(storeRead));
  check("the total names that currency field", /currencyField:\s*"currency"/.test(storeRead));
  check("cells format with the row currency", /fmt\.money\(n, currency\)/.test(views));
  check("and render the estimate under it", /fmt\.approx\(n, currency\)/.test(views));
  check("assistant snapshots label each order from its row", /o\.currency \?\? store\.currency/.test(ai));
  check(
    "mixed-currency stats are refused rather than summed",
    renderer.includes('display: "Mixed currencies"')
  );
  check(
    "the section and chat preview share the same source-currency default",
    (shell.match(/currency=\{sectionMoneyCurrency\}/g) ?? []).length >= 2
  );

  // The reader has to be told what the small number is, or it becomes
  // a figure somebody quietly trusts.
  check("the screen says the estimate is today's rate", /rough\s*\n?\s*conversion at today/.test(shell) || /rough conversion at today/.test(shell));
  check("and says not to reconcile with it", /never to reconcile/.test(shell));
}

console.log(fails.length === 0 ? "\nmoney means what its source says" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
