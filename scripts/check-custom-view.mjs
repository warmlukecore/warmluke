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
  customViewScriptProblem,
} from "../src/lib/custom-view.ts";
import { parseReply, sectionsRead } from "../src/lib/ai.ts";

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

// A question is the app's dialog, not the browser's: alert, confirm and
// prompt do nothing in the sealed frame.
console.log("\na screen asks in the app's dialog");
const asking = customViewPage(screen, [], {});
check("every screen is given wl.ask", /\bask,/.test(asking) && asking.indexOf("ask,") < asking.indexOf("wl.onRows"));
check(
  "drawn by the kit, in the app's depth",
  CUSTOM_VIEW_KIT.includes(".wl-dialog") && "shadow-dialog" in CUSTOM_VIEW_TOKENS
);
check("and alert shows it rather than nothing", /window\.alert\s*=/.test(asking));

// The rest of the app, read only, and money as the app writes it.
console.log("\nwhat a screen reads beyond its rows, and how it says money");
const reading = customViewPage(screen, [{ field: "price", label: "Price $& more", type: "currency" }], {}, "", {
  locale: "en-IN",
  currency: "INR",
});
check("every screen is given wl.read, and wl.money", /\bread:/.test(reading) && /\bmoney,/.test(reading));
check("with the app's locale and the project's currency", reading.includes('{"locale":"en-IN","currency":"INR"}'));
check("and a label with $& in it is carried as it is, not read as a pattern", reading.includes("Price $& more"));

// Light or dark as the app chose it, and a switch taken in place: the
// computer's setting drew a light box inside a dark app, and values read
// once kept a screen in the theme it opened in.
console.log("\na screen is light or dark as the app is");
check("light unless told", customViewPage(screen, [], {}).includes("color-scheme:light}"));
const night = customViewPage(screen, [], {}, "", undefined, "dark");
check(
  "dark when the app is, and never the computer's choice",
  night.includes("color-scheme:dark}") && !night.includes("light dark")
);
check(
  "and told new values while open, without a reload",
  /m\.type === "colours"/.test(night) && /setProperty\("--" \+ k/.test(night)
);

// A screen whose script cannot parse is a blank screen: it goes back to
// Luke with the browser's words. Parsing only; a screen that parses is
// never refused for it, whatever modern syntax it uses.
console.log("\na screen's script is parsed before it is shown");
const broken = customViewScriptProblem("<div id=a></div><script>const x = ;</script>");
check(
  "a script that cannot parse is refused, in the browser's words",
  typeof broken === "string" && /would not run/.test(broken)
);
const modern = `<div class=wl-page><input id=scan class=wl-scan></div>
<script type="text/javascript">
const S = { order: null, lines: [] };
const cur = () => S.lines.find((l) => (l.data?.scanned_qty ?? 0) < +l.data.quantity);
class Beep { play() { return \`ok \${1 + 1}\`; } }
async function open(n) { const rows = await wl.find("order_number", \`#\${n}\`); S.lines = [...rows]; }
</script><script>wl.onRows((rows) => { for (const r of rows) void r; });</script>`;
check("a screen in today's syntax parses, and is not refused", customViewScriptProblem(modern) === null);
check("and parsing runs nothing", customViewScriptProblem("<script>throw new Error('ran')</script>") === null);

console.log("\nthe sections a screen reads are there (Returns, 3 Oct)");
{
  const ORD = "88888888-8888-4888-8888-888888888888";
  const RET = "99999999-9999-4999-8999-999999999999";
  const modules = [
    { id: ORD, project_id: "p", name: "orders", nav_label: "Orders", icon: "table", source_table: "orders" },
    { id: RET, project_id: "p", name: "returns-dashboard", nav_label: "Returns", icon: "table", source_table: null },
  ];
  const html = (read) =>
    `<div id=app></div><script>async function go(q){ const o = await wl.find("order_number", q, "#orders"); const l = await wl.find("order_number", q, "${read}"); app.textContent = o.length + l.length; }</script>`;
  check(
    "the reads are found, literal words only",
    sectionsRead(html("#order_lines")).join() === "#orders,#order_lines" &&
      sectionsRead('<script>wl.find("sku", code)</script>').length === 0
  );
  const design = (read, extra = []) =>
    parseReply(
      JSON.stringify({
        type: "plans",
        message: "A returns screen.",
        plans: [
          ...extra,
          {
            changeType: "FEATURE_UPDATE",
            targetModuleId: RET,
            features: { view: { type: "custom", title: "Returns", html: html(read) } },
            explanation: "A screen to log returns.",
          },
        ],
      }),
      modules,
      { columns: [{ field: "order_number", label: "Order", type: "text" }] },
      null
    );
  const missing = design("#return-order-items");
  check(
    "a section that is not there is refused, naming the ones that are",
    !missing.ok &&
      missing.errors.join(" ").includes('"#return-order-items"') &&
      missing.errors.join(" ").includes("#orders")
  );
  const here = design("Orders");
  check("one that is there, however it is spelled, is taken", here.ok);
  if (!here.ok) console.log("     →", here.errors);
  const made = design("#return-items", [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: "return-items", nav_label: "Return items", icon: "table" },
      newSchema: { columns: [{ field: "order_number", label: "Order", type: "text" }] },
      explanation: "The items of each return.",
    },
  ]);
  check("and so is one the same design creates", made.ok);
  if (!made.ok) console.log("     →", made.errors);
}

console.log("\nthe kit draws what screens were hand-styling");
{
  const page = customViewPage("<select id=t><option>Refund</option></select>", [], {});
  for (const part of ["wl-form", "wl-field", "wl-table", "wl-empty", "wl-select", "wl-menu", "wl-head"])
    check(`the kit has ${part}`, CUSTOM_VIEW_KIT.includes(`.${part}`));
  check(
    "and wl.date, wl.label and the app's list for a select are in the page",
    ["date,", "label,", "upgradeAll"].every((w) => page.includes(w))
  );
  check("with the app's own words for a store status", page.includes('"PENDING":"Payment pending"'));
  check("and its date pattern intact (no lost backslash)", page.includes("/^\\d{4}-\\d{2}-\\d{2}$/"));
}

console.log(
  fails.length === 0 ? "\na written screen runs sealed, and only with what it is for" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
