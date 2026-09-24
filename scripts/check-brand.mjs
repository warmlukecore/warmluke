// The logo is one file, found wherever it is shown.
//
// public/brand/ holds the logo and nothing else, under any name; the
// build reads it (src/lib/brand-file.mjs) and the app shows it through
// LOGO (src/lib/brand.ts). A path to an image typed into a component
// would be a logo that stays behind the day the file changes.
//
//   node scripts/check-brand.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_DIR, findLogo } from "../src/lib/brand-file.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the logo is the one image in public/brand/");
let logo = null;
try {
  logo = findLogo(root);
} catch (e) {
  console.log(`  ${e.message}`);
}
check("exactly one image is there", !!logo);
check("and it is really a file", !!logo && statSync(path.join(root, "public", decodeURIComponent(logo))).isFile());
const config = readFileSync(path.join(root, "next.config.mjs"), "utf8");
check("the build reads it", /const logo = findLogo\(projectDir\)/.test(config) && /NEXT_PUBLIC_LOGO:\s*logo\b/.test(config));
check("and measures where the mark sits in it", /NEXT_PUBLIC_LOGO_BOX:\s*logoBox/.test(config));

console.log("\nand nothing names it");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(tsx?|mjs|css)$/.test(d.name) ? [path.join(dir, d.name)] : []
  );
// The two files that define where the logo lives are the only ones that may say so.
const OWN = new Set(["src/lib/brand-file.mjs", "src/lib/brand.ts"].map((f) => path.join(root, f)));
const typed = walk(path.join(root, "src")).filter((f) => {
  if (OWN.has(f)) return false;
  const code = readFileSync(f, "utf8");
  return /["'`]\/(brand|images)\/[^"'`]+\.(png|svg|jpe?g|webp|avif)/i.test(code);
});
check(
  `no file under src/ types a path into ${BRAND_DIR}/ or the old images/${typed.length ? ` (${typed.map((f) => path.relative(root, f)).join(", ")})` : ""}`,
  typed.length === 0
);
check("the favicon is drawn from the same file", /from "@\/lib\/brand"/.test(readFileSync(path.join(root, "src/app/icon.tsx"), "utf8")));

console.log(fails.length === 0 ? "\none logo, found everywhere" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
