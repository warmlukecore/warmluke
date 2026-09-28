// A screen Luke writes (lib/custom-view): what it may hold, and the page it runs in.
//
// A screen that does what it is for is taken. One with a web address, a
// way off the page, a frame, a form, a script from elsewhere or a call
// to the network is refused, and so is one past the size a screen
// should be. The page it runs in starts with a policy that shuts the
// network, carries the section's columns safely, and gives window.wl
// before the screen's own code.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-custom-view.mjs

import {
  CUSTOM_VIEW_CSP,
  CUSTOM_VIEW_KIT,
  CUSTOM_VIEW_MAX,
  CUSTOM_VIEW_TOKENS,
  customViewPage,
  customViewProblem,
} from "../src/lib/custom-view.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const screen = `<div id=app>Bin location: A3</div><script>wl.onRows((rows) => { app.textContent = rows.length + " lines"; });</script>`;

console.log("what a screen may hold");
check("a screen that only talks to wl is taken, words like 'location' and all", customViewProblem(screen) === null);
for (const [what, html] of [
  ["a web address", `<img src="https://x.test/p.png">`],
  ["an address without its scheme", `<img src="//x.test/p.png">`],
  ["leaving the page", `<script>location.href = "/x"</script>`],
  ["opening a window", `<script>window.open("/x")</script>`],
  ["a frame of its own", `<iframe></iframe>`],
  ["a form", `<form></form>`],
  ["a script from elsewhere", `<script src="a.js"></script>`],
  ["a call to the network", `<script>fetch("/api/records")</script>`],
  ["a socket", `<script>new WebSocket("wss:x")</script>`],
]) {
  check(`${what} is refused`, typeof customViewProblem(html) === "string");
}
check(
  "and so is one past the size a screen should be",
  /keep it under/.test(customViewProblem("x".repeat(CUSTOM_VIEW_MAX + 1)) ?? "")
);
check(
  "and one with nothing in it",
  typeof customViewProblem("   ") === "string" && typeof customViewProblem(null) === "string"
);

console.log("\nthe page it runs in");
const page = customViewPage(screen, [{ field: "note", label: "</script><script>x()", type: "text" }], { fg: "red;}" });
check(
  "the policy is the first thing in its head",
  page.indexOf(CUSTOM_VIEW_CSP) > 0 && page.indexOf(CUSTOM_VIEW_CSP) < page.indexOf("<script>")
);
check(
  "and it shuts the network and every frame and form",
  /default-src 'none'/.test(CUSTOM_VIEW_CSP) &&
    /form-action 'none'/.test(CUSTOM_VIEW_CSP) &&
    /frame-src 'none'/.test(CUSTOM_VIEW_CSP)
);
check("window.wl comes before the screen's own code", page.indexOf("window.wl") < page.indexOf("wl.onRows"));
check("a column label cannot close the script it is carried in", !page.includes("</script><script>x()"));
check("nor a colour break out of its rule", !/--fg:red;}/.test(page));

// The app's look comes with the page, so a screen builds from it rather
// than inventing one: its faces, its values, and the kit's pieces.
console.log("\nthe app's look, on the page");
const face = '@font-face{font-family:"WL Sans";src:url(data:font/woff2;base64,AAAA) format("woff2")}';
const styled = customViewPage(screen, [], { "radius-card": "0.75rem" }, face);
check(
  "the kit is in every page, before the screen's own code",
  styled.indexOf(CUSTOM_VIEW_KIT) > 0 && styled.indexOf(CUSTOM_VIEW_KIT) < styled.indexOf("wl.onRows")
);
check(
  "with the app's corners and depth among its values",
  "radius-card" in CUSTOM_VIEW_TOKENS && "shadow-card" in CUSTOM_VIEW_TOKENS && styled.includes("--radius-card:0.75rem")
);
check(
  "the faces it is handed come first, inline, as the policy allows",
  styled.indexOf(face) > 0 &&
    styled.indexOf(face) < styled.indexOf(CUSTOM_VIEW_KIT) &&
    /font-src data:/.test(CUSTOM_VIEW_CSP)
);
check(
  "and a face cannot close the style it is carried in",
  !customViewPage(screen, [], {}, "</style><script>x()</script>").includes("</style><script>x()")
);
check(
  "every piece the prompt names is drawn by the kit",
  [
    "wl-page",
    "wl-stack",
    "wl-inline",
    "wl-grid",
    "wl-card",
    "wl-title",
    "wl-big",
    "wl-count",
    "wl-label",
    "wl-muted",
    "wl-scan",
    "wl-banner",
    "wl-list",
    "wl-row",
    "wl-button",
    "wl-badge",
  ].every((c) => CUSTOM_VIEW_KIT.includes(`.${c}`))
);
check(
  "and it sets no colour of its own but white on the solid red",
  !/#[0-9a-f]{3,6}\b/i.test(CUSTOM_VIEW_KIT.replace("color:#fff", ""))
);

console.log(
  fails.length === 0 ? "\na written screen runs sealed, and only with what it is for" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
