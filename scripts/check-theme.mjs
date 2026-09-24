// Dark means every token, not most of them.
//
// The app's dark theme is the product tokens given night values under
// [data-theme="dark"] in globals.css. A token added later without one
// keeps its day value at night: a white card on a dark page, pale text
// on a pale tint, and nothing fails to build. So every colour and
// shadow token must have a night value, unless it is listed here as
// the same in both on purpose.
//
//   node scripts/check-theme.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** The same by day and night: the landing's own palette, Luke's colours, and signals bright enough for both. */
const BOTH = [
  /^--color-(accent|ink|quiet|hair)$/,
  /^--color-luke/,
  /^--color-signal-(success|attention|info|critical)$/,
];

const css = read("src/app/globals.css");
const block = (opener) => {
  const at = css.indexOf(opener);
  return at < 0 ? "" : css.slice(at, css.indexOf("\n}", at));
};
const theme = block("@theme {");
const dark = block('[data-theme="dark"] {');
const tokens = [...theme.matchAll(/^\s*(--(?:color|shadow)-[a-z0-9-]+):/gm)].map((m) => m[1]);
const night = new Set([...dark.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));

console.log("every product token has a night value");
check("the dark block is there", dark.length > 0);
const missing = tokens.filter((t) => !night.has(t) && !BOTH.some((re) => re.test(t)));
check(`${tokens.length} tokens, none left out`, tokens.length > 0 && missing.length === 0);
if (missing.length) console.log("     →", missing.join(", "));
const stray = [...night].filter((t) => !tokens.includes(t));
check("and the dark block names no token that does not exist", stray.length === 0);
if (stray.length) console.log("     →", stray.join(", "));

console.log("\nand a primary fill carries its own words");
// White words on the primary fill were right while primary was dark;
// at night primary is light, and they vanish. on-primary moves with it.
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const p = `${dir}/${f}`;
    if (statSync(new URL(`../${p}`, import.meta.url)).isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(f)) files.push(p);
  }
};
walk("src/components");
walk("src/app");
const white = files.filter((f) => /"[^"\n]*\bbg-primary\b[^"\n]*\btext-white\b|"[^"\n]*\btext-white\b[^"\n]*\bbg-primary\b/.test(read(f)));
check("no bg-primary with text-white", white.length === 0);
if (white.length) console.log("     →", white.join(", "));

console.log("\nand the few raw colours have a night pair");
// The calm badge colours are the app's one set of raw Tailwind colours,
// so the dark tokens do not reach them: each carries its own dark: pair.
const tone = read("src/lib/tone.ts");
const quiet = tone.slice(tone.indexOf("const QUIET = ["), tone.indexOf("];", tone.indexOf("const QUIET = [")));
const swatches = [...quiet.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
check(`all ${swatches.length} calm colours`, swatches.length > 0 && swatches.every((c) => /dark:bg-/.test(c) && /dark:text-/.test(c)));
check("and dark: follows the app's switch, not the computer's", /@custom-variant dark \(&:where\(\[data-theme="dark"\]/.test(css));

console.log("\nand the choice is on the page before it paints");
const layout = read("src/app/layout.tsx");
check("the root layout runs the theme script in <head>", /THEME_SCRIPT/.test(layout) && /<head>/.test(layout));
check("and expects the attribute React did not write", /suppressHydrationWarning/.test(layout));

console.log(fails.length === 0 ? "\nday and night, every token" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
