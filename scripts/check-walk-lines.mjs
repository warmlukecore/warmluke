// What the browser walk hands its page and says of it (lib/walk.ts, 5 Oct):
// the section's input put in where the page reads it, a written screen's
// own </script> unable to end the page's; and what broke said once,
// whichever width it broke at, naming the width when only one did. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-walk-lines.mjs

import { walkBreaks, walkPage, WALK_WIDTHS } from "../src/lib/walk.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("the page, with the section in it");
{
  const page = "<script>window.__WALK__=/*WL_WALK*/null;</script>";
  const put = walkPage(page, { html: "<script>x()</script>" });
  check("put where the page reads it", put.startsWith("<script>window.__WALK__={"));
  check("a screen's own </script> cannot end the page's", !put.slice(8).includes("</script>x"));
  check("and it reads back as it was", JSON.parse(put.slice(24, -10)).html === "<script>x()</script>");
}

console.log("\nwhat broke, said once");
{
  const step = (what, ok, why) => ({ what, ok, ...(why ? { why } : {}) });
  const walked = [
    {
      width: 1440,
      errors: [],
      steps: [step("Filter by Reason", false, "it offers nothing to choose"), step("Search", true)],
    },
    {
      width: 390,
      errors: [],
      steps: [
        step("Filter by Reason", false, "it offers nothing to choose"),
        step("Adding a row with the form", false, "the form would not save"),
      ],
    },
  ];
  const said = walkBreaks(walked);
  check("a break at both widths, said once", said.filter((s) => s.startsWith("Filter by Reason")).length === 1);
  check("as the person meets it", said[0] === "Filter by Reason: it offers nothing to choose");
  check(
    "one at a phone's width alone, says so",
    said[1] === "Adding a row with the form: the form would not save (on a phone)"
  );
  check(
    "nothing broke: nothing said",
    walkBreaks([{ width: 1440, errors: [], steps: [step("Search", true)] }]).length === 0
  );
  check("a laptop's width and a phone's", WALK_WIDTHS.map((w) => w.w).join() === "1440,390" && WALK_WIDTHS[1].phone);
}

console.log(fails.length === 0 ? "\nthe walk is handed its section and says what broke" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
