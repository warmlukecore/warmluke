// Builds the walk page (src/walk/page.tsx): a section drawn by the app's
// own components, with the app's own CSS, as one sealed HTML file the
// tryout's browser walk opens (lib/walk.ts). Run before every build
// (package.json "build"), so the page is always the app as it ships:
// never a copy kept by hand.
//
// The page loads nothing. Its script and CSS are inline; the app's two
// faces go where /*WL_FACES*/ is (the sandbox fills it from its snapshot,
// as the screen check's pages are filled); the walk's input goes where
// /*WL_WALK*/ is. The database client is swapped for nothing
// (src/walk/no-db.ts): a sealed page has no database to ask.
//
//   node scripts/build-walk-page.mjs        writes .walk/walk.html

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const t0 = Date.now();

// The app's "@/..." paths, and the database client swapped for nothing.
const paths = {
  name: "app-paths",
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/supabase-client$/ }, () => ({ path: resolve(root, "src/walk/no-db.ts") }));
    b.onResolve({ filter: /^@\// }, async (args) =>
      b.resolve(`./${args.path.slice(2)}`, { resolveDir: resolve(root, "src"), kind: args.kind })
    );
  },
};

const js = await build({
  entryPoints: [resolve(root, "src/walk/page.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [paths],
  logLevel: "warning",
});

const cssFrom = resolve(root, "src/app/globals.css");
const css = await postcss([tailwind({ base: root })]).process(readFileSync(cssFrom, "utf8"), { from: cssFrom });

// The app's faces by the names the sandbox gives them; a browser without them draws its own sans.
const faces = `/*WL_FACES*/:root{--font-manrope:"WL Sans";--font-inter:"WL Sans";--font-bricolage:"WL Display";--font-instrument:"WL Display"}`;
const script = js.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Walk</title><style>${faces}</style><style>${css.css}</style></head><body class="antialiased"><div id="root"></div><script>window.__WALK__=/*WL_WALK*/null;</script><script>${script}</script></body></html>`;

mkdirSync(resolve(root, ".walk"), { recursive: true });
writeFileSync(resolve(root, ".walk/walk.html"), html);
console.log(`.walk/walk.html: ${Math.round(html.length / 1024)} KB in ${Date.now() - t0}ms`);
