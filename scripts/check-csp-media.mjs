// Every film the page plays is one the policy lets through.
//
// This failure is the quiet kind, which is why it is worth a check
// of its own. A <video> pointing at a host the Content-Security
// -Policy does not allow renders perfectly, throws nothing the
// server can see, and is refused in the browser with a console line
// nobody is watching. The hero simply never moves, and the headers
// look correct from curl.
//
// It cost a real debugging session: default-src 'self' with no
// media-src beside it blocked the hero video outright, and only a
// screenshot found it.
//
// Needs no database and no network — it reads two files.
//
//   node scripts/check-csp-media.mjs

import { readFileSync } from "node:fs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const config = read("next.config.mjs");

console.log("the policy says something about media at all");
// Without this line the directive falls back to default-src, and
// that fallback is the whole bug.
const directive = /media-src([^`"']*)/.exec(config);
check("media-src is named in the policy", !!directive);
check("and it still allows this origin's own files", /media-src[^`"']*'self'/.test(config));

// Whatever the config interpolates, resolved to the literal origins
// it will actually send. There are none today: the film is served
// from here. The set stays because the day one is added back, both
// halves of this check have to still work.
const origins = new Set();
const named = /const\s+HERO_VIDEO_ORIGIN\s*=\s*"([^"]+)"/.exec(config);
if (named) origins.add(named[1]);
for (const m of (directive?.[1] ?? "").matchAll(/https:\/\/[^\s`"';]+/g)) origins.add(m[0]);
console.log(`  policy allows media from: ${[...origins].join(", ") || "nothing external"}`);

console.log("\nand every video the landing page plays is allowed");
const page = read("src/app/page.tsx");
const played = [...page.matchAll(/<source\s+src="([^"]+\.(?:mp4|webm|mov))"/g)].map((m) => m[1]);
check("the page plays at least one", played.length > 0);
for (const src of played) {
  // A path beginning with / is served by this origin, which 'self'
  // covers. Anything else has to be named in the policy.
  if (src.startsWith("/")) {
    check(`${src} is our own file, covered by 'self'`, true);
    // And it has to be a file that exists, or the hero is as still
    // as it would be with the policy wrong.
    let there = true;
    try {
      readFileSync(new URL(`../public${src}`, import.meta.url));
    } catch {
      there = false;
    }
    check(`and public${src} is really there`, there);
  } else {
    const origin = new URL(src).origin;
    check(`${origin} is allowed by media-src`, origins.has(origin));
  }
}

// And the reverse, so the policy does not keep widening for hosts
// nobody uses any more.
for (const origin of origins) {
  check(
    `${origin} is actually used by the page`,
    played.some((u) => !u.startsWith("/") && new URL(u).origin === origin)
  );
}

// The reason the file was brought in-house. Eight seconds of 1080p
// straight off a generator was eighteen megabytes, downloaded in
// full by every phone that opened the page, and nothing about the
// page said so. A budget nobody can see is a budget that drifts.
console.log("\nand it is small enough to put in front of a phone");
for (const src of played.filter((u) => u.startsWith("/"))) {
  let mb = Infinity;
  try {
    mb = readFileSync(new URL(`../public${src}`, import.meta.url)).length / 1048576;
  } catch {
    // Reported as missing above.
  }
  check(`${src} is under 3 MB (${mb.toFixed(1)} MB)`, mb < 3);
}

console.log(fails.length === 0 ? "\nthe hero can play what it points at" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
