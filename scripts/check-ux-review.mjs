// The screen check (lib/ux-review), with no sandbox and no model: both
// are handed in as stand-ins, and what they are given is read back.
//
// A design's written screens are found (two at most), each built as the
// app builds it, over its rows with the people taken out; photographed,
// or read as code when the pictures cannot be had; looked at once; and
// the verdicts made one. With the setting off nothing is called, and the
// time allowed is the time it takes.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-ux-review.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  combineVerdicts,
  findScreens,
  madeUpRows,
  parseUxVerdict,
  redact,
  reviewScreens,
  screenDocument,
  UX_RUBRIC_CODE,
  UX_RUBRIC_SHOTS,
  UX_WIDTHS,
} from "../src/lib/ux-review.ts";
import { FACES_HERE, SHOOTER } from "../src/lib/screen-shot.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
// The [ux] lines are the log's; kept here so the run reads cleanly.
const logged = [];
console.warn = (line) => logged.push(String(line));
console.error = (line) => logged.push(String(line));

const plan = (p) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: null,
  newSchema: { columns: [] },
  moduleUpdate: null,
  deleteConfirmName: null,
  features: null,
  automation: null,
  automationRemoveName: null,
  newRecords: null,
  explanation: "",
  ...p,
});
const returnsScreen = `<div class="wl-page"><h1>Returns</h1><div id=list class="wl-list"></div></div><script>wl.onRows((rows) => { list.textContent = rows.map((r) => r.data.order_no).join(" "); });</script>`;
const returns = plan({
  newModule: { name: "returns", nav_label: "Returns", icon: "undo" },
  newSchema: {
    columns: [
      { field: "order_no", label: "Order", type: "text" },
      { field: "email", label: "Email", type: "email" },
      { field: "qty", label: "Qty", type: "number" },
      { field: "price", label: "Price", type: "currency" },
      {
        field: "total",
        label: "Total",
        type: "currency",
        compute: { op: "*", args: [{ field: "qty" }, { field: "price" }] },
      },
    ],
  },
  features: { view: { type: "custom", title: "Returns desk", html: returnsScreen } },
  newRecords: [
    { order_no: "#1001", email: "priya.sharma@gmail.com", qty: 2, price: 450 },
    { order_no: "#1002", email: "ravi@shop.in", qty: 1, price: 999 },
  ],
});
const plain = plan({
  newModule: { name: "notes", nav_label: "Notes", icon: "note" },
  newSchema: { columns: [{ field: "note", label: "Note", type: "text" }] },
});
const blank = plan({
  newModule: { name: "packing", nav_label: "Packing", icon: "box" },
  newSchema: {
    columns: [
      { field: "sku", label: "SKU", type: "barcode" },
      { field: "packed_on", label: "Packed on", type: "date" },
    ],
  },
  features: { view: { type: "custom", title: "Packing station", html: "<div class=wl-page>Scan</div>" } },
});
// An existing section of the owner's, a screen added beside its table.
const shipments = { id: "m-ship", name: "shipments", nav_label: "Shipments", icon: "truck", source_table: null };
const tabbed = plan({
  changeType: "FEATURE_UPDATE",
  targetModuleId: "m-ship",
  features: { tabs: [{ type: "custom", title: "Dispatch", html: "<div class=wl-page>Dispatch</div>" }] },
});
const third = plan({
  newModule: { name: "extra", nav_label: "Extra", icon: "box" },
  newSchema: { columns: [{ field: "a", label: "A", type: "text" }] },
  features: { view: { type: "custom", title: "Third", html: "<div>third</div>" } },
});

// The caller's client, stood in for: what each table answers, whatever is asked.
const read = [];
const db = {
  from: (table) => {
    read.push(table);
    const answer =
      table === "ui_schemas"
        ? {
            data: {
              schema_json: {
                columns: [
                  { field: "awb", label: "AWB", type: "text" },
                  { field: "phone", label: "Phone", type: "phone" },
                ],
              },
            },
          }
        : { data: [{ id: "r1", data: { awb: "AWB123", phone: "+91 99887 66554", shipped: "2026-10-02" } }] };
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => answer,
      then: (ok, no) => Promise.resolve(answer).then(ok, no),
    };
    return q;
  },
};
const ctx = (over = {}) => ({
  db,
  projectId: "p1",
  store: null,
  modules: [shipments],
  schemas: new Map(),
  ownerWords: "a returns desk",
  understood: "",
  locale: "en-IN",
  currency: "INR",
  uxModel: "vision-test",
  ...over,
});

console.log("the written screens in a design");
const found = await findScreens(ctx(), [plain, returns, tabbed, third]);
check(
  "a screen in a new section and one added as a tab, two at most",
  found.map((s) => s.title).join() === "Returns desk,Dispatch"
);
const desk = found[0];
check(
  "a new section is drawn over its own demo rows",
  desk.rows.length === 2 && desk.rows[0].data.order_no === "#1001"
);
check("its computed fields worked out, as the frame is handed them", desk.rows[0].data.total === 900);
check(
  "and its people taken out",
  desk.rows.every((r) => r.data.email === "customer@example.com")
);
const dispatch = found[1];
check("a section that is there is drawn over its own rows", dispatch.rows[0]?.data.awb === "AWB123");
check(
  "its phone a look-alike of the same shape",
  /^\+\d\d \d{5} \d{5}$/.test(dispatch.rows[0].data.phone) && dispatch.rows[0].data.phone !== "+91 99887 66554"
);
check("and its date left as it is", dispatch.rows[0].data.shipped === "2026-10-02");
const packing = await findScreens(ctx(), [blank]);
check(
  "a new section with no demo rows gets a few made up from its fields",
  packing[0]?.rows.length === 5 && /^\d{4}-\d{2}-\d{2}$/.test(packing[0].rows[0].data.packed_on)
);
check(
  "made-up rows follow each field's type",
  madeUpRows([{ field: "paid", label: "Paid", type: "boolean" }])[0].data.paid === true
);
check("no written screen, nothing found", (await findScreens(ctx(), [plain])).length === 0);
read.length = 0;
const fieldAdd = plan({
  changeType: "FIELD_ADD",
  targetModuleId: "m-ship",
  newSchema: { columns: [{ field: "cod", label: "COD", type: "boolean" }] },
});
await findScreens(ctx(), [fieldAdd, returns]);
check("a change with no screen is not read for one", read.length === 0);

console.log("\nthe people in a row");
const r = redact({
  note: "call 98200 12345 or mail a.b@x.co about 2026-10-02",
  customer: { email: "x@y.com", phone: "022-2345-6789", address: "Flat 4, Marine Drive" },
  tags: ["vip@club.in"],
  qty: 4,
  order_no: "#1001",
});
check(
  "an email in the words becomes a look-alike",
  r.note.includes("customer@example.com") && !r.note.includes("a.b@x.co")
);
check(
  "a phone in the words keeps its shape, not its digits",
  /\d{5} \d{5}/.test(r.note) && !r.note.includes("98200 12345")
);
check("a date in the words is not a phone", r.note.includes("2026-10-02"));
check(
  "nested, by its field's name too",
  r.customer.email === "customer@example.com" &&
    r.customer.phone !== "022-2345-6789" &&
    /^\d{3}-\d{4}-\d{4}$/.test(r.customer.phone)
);
check("an address is not anyone's", r.customer.address !== "Flat 4, Marine Drive");
check("in a list as well", r.tags[0] === "customer@example.com");
check("numbers and codes untouched", r.qty === 4 && r.order_no === "#1001");

console.log("\nthe page the browser opens");
const doc = screenDocument(desk, { locale: "en-IN", currency: "INR" });
check(
  "the screen runs in a frame sealed as the app seals it",
  /<iframe sandbox="allow-scripts"/.test(doc) && !/allow-same-origin/.test(doc)
);
check("with the app's kit", doc.includes("wl-page{max-width:960px"));
check("and its own policy, first in its head", doc.includes("default-src 'none'"));
check("the screen itself inside", doc.includes("wl.onRows((rows)"));
check(
  "its rows handed to it",
  doc.includes('"order_no":"#1001"') && doc.includes('send({ wl: 1, type: "rows", rows })')
);
check("the app's faces have their place", doc.includes(FACES_HERE));
check("in the app's colours", doc.includes("--surface:hsl(0 0% 100%)"));
check(
  "nothing in a row can end the page's script",
  !screenDocument(
    { ...desk, rows: [{ id: "x", data: { n: "</script><script>x()" } }] },
    { locale: "en-IN", currency: "INR" }
  ).includes("</script><script>x()")
);
const hostScript = /<script>([\s\S]*)<\/script><\/body>/.exec(doc)?.[1] ?? "";
// Compiled, never run.
let parses;
try {
  parses = typeof new Function(hostScript) === "function";
} catch {
  parses = false;
}
check("the page's own script parses", hostScript.length > 0 && parses);
// The machine's script is a module: node --check reads it as one.
const dir = mkdtempSync(join(tmpdir(), "ux-shooter-"));
writeFileSync(join(dir, "shoot.mjs"), SHOOTER);
check(
  "the browser's script in the machine parses",
  spawnSync(process.execPath, ["--check", join(dir, "shoot.mjs")]).status === 0
);

console.log("\nthe model's answer");
check("bad JSON is no verdict", parseUxVerdict("looks fine to me") === null);
check("a verdict it does not know is none", parseUxVerdict('{"verdict":"maybe"}') === null);
check(
  "fenced JSON reads",
  parseUxVerdict('```json\n{"verdict":"pass","issues":[],"fix":null}\n```')?.verdict === "pass"
);
check(
  "words around it too",
  parseUxVerdict('Here it is: {"verdict":"redo","issues":["PENDING shown"],"fix":"use wl.label"} done')?.fix ===
    "use wl.label"
);
const capped = parseUxVerdict(
  JSON.stringify({ verdict: "redo", issues: Array.from({ length: 9 }, (_, i) => `issue ${i}`), fix: "x".repeat(900) })
);
check("issues capped at six, the fix at 300 characters", capped?.issues.length === 6 && capped.fix.length === 300);
check("a pass carries no fix", parseUxVerdict('{"verdict":"pass","issues":["small"],"fix":"do x"}')?.fix === null);
check(
  "sent back with no fix, the first issue is the fix",
  parseUxVerdict('{"verdict":"redo","issues":["dates wrap"],"fix":null}')?.fix === "dates wrap"
);
check(
  "sent back with nothing to change is a pass",
  parseUxVerdict('{"verdict":"redo","issues":[],"fix":""}')?.verdict === "pass"
);

console.log("\nlooking");
const calls = { shoot: 0, look: [] };
const shot = (w, h) => ({ w, h, png: "aGk=", mediaType: "image/png" });
const shooter = async (html, opts) => {
  calls.shoot += 1;
  return opts.widths.map((x) => shot(x.w, x.h));
};
const looker = (answers) => async (model, system, turn) => {
  calls.look.push({ model, system, turn });
  return answers.shift() ?? '{"verdict":"pass","issues":[],"fix":null}';
};
const reset = () => {
  calls.shoot = 0;
  calls.look = [];
};

reset();
const off = await reviewScreens(ctx({ uxModel: null }), [returns], { shoot: shooter, look: looker([]) });
check(
  "with the setting off, skipped at once, nothing called",
  off.verdict === "skipped" && off.how === "none" && calls.shoot === 0 && calls.look.length === 0
);

reset();
const none = await reviewScreens(ctx(), [plain], { shoot: shooter, look: looker([]) });
check(
  "no written screen, skipped, nothing called",
  none.verdict === "skipped" && calls.shoot === 0 && calls.look.length === 0
);

reset();
const seen = await reviewScreens(ctx(), [returns], {
  shoot: shooter,
  look: looker(['{"verdict":"pass","issues":[],"fix":null}']),
});
const asked = calls.look[0];
check(
  "photographed at a laptop's width and a phone's",
  UX_WIDTHS.map((x) => x.w).join() === "1440,390" && calls.shoot === 1
);
check(
  "looked at on the model set, against the rules for pictures",
  asked?.model === "vision-test" && asked.system === UX_RUBRIC_SHOTS
);
check(
  "both pictures go with the words",
  asked?.turn.images?.length === 2 &&
    asked.turn.images[0].mediaType === "image/png" &&
    /Returns desk/.test(asked.turn.content)
);
check(
  "a pass, from the pictures, timed",
  seen.verdict === "pass" && seen.how === "screenshot" && typeof seen.ms === "number"
);

reset();
const blind = await reviewScreens(ctx(), [returns], {
  shoot: async () => {
    throw new Error("screens unavailable: SCREEN_SNAPSHOT_ID is not set");
  },
  look: looker(['{"verdict":"redo","issues":["Status prints PENDING"],"fix":"Print statuses with wl.label."}']),
});
check(
  "no pictures: the code is read instead",
  calls.look[0]?.system === UX_RUBRIC_CODE &&
    !calls.look[0].turn.images &&
    calls.look[0].turn.content.includes("wl.onRows")
);
check(
  "on the same rules, said as text",
  blind.verdict === "redo" && blind.how === "text" && blind.fix === "Print statuses with wl.label."
);
check(
  "and the log says why",
  logged.some((l) => l.startsWith("[ux] screens unavailable: SCREEN_SNAPSHOT_ID is not set"))
);

reset();
const two = await reviewScreens(ctx(), [returns, tabbed], {
  shoot: shooter,
  look: looker([
    '{"verdict":"pass","issues":["a small gap"],"fix":null}',
    '{"verdict":"redo","issues":["the AWB wraps"],"fix":"Keep the AWB on one line."}',
  ]),
});
check("two screens, two looks", calls.look.length === 2);
check("one sent back sends the design back", two.verdict === "redo");
check(
  "issues together, each with its screen",
  two.issues.join("|") === "Returns desk: a small gap|Dispatch: the AWB wraps"
);
check("one line to the designer, naming the screen", two.fix === "Dispatch: Keep the AWB on one line.");
check(
  "a screen with no verdict leaves the other's",
  combineVerdicts([null, { verdict: "pass", how: "text", issues: [], fix: null, title: "A" }]).verdict === "pass"
);
check("none at all is skipped", combineVerdicts([null, null]).verdict === "skipped");
check(
  "a screen read as code makes the whole a text review",
  combineVerdicts([
    { verdict: "pass", how: "screenshot", issues: [], fix: null, title: "A" },
    { verdict: "pass", how: "text", issues: [], fix: null, title: "B" },
  ]).how === "text"
);

console.log("\nthe time allowed");
reset();
let t0 = Date.now();
const slowShots = await reviewScreens(ctx(), [returns], {
  shoot: () => new Promise(() => {}),
  look: looker([]),
  shootMs: 50,
  budgetMs: 5000,
});
check("pictures too slow: read as code, soon after", slowShots.how === "text" && Date.now() - t0 < 2000);
reset();
t0 = Date.now();
const slowLook = await reviewScreens(ctx(), [returns], {
  shoot: shooter,
  look: () => new Promise(() => {}),
  budgetMs: 200,
});
check(
  "a look that never answers: skipped at the budget, not after",
  slowLook.verdict === "skipped" && Date.now() - t0 < 1500
);
reset();
const stopped = new AbortController();
stopped.abort();
const gone = await reviewScreens(ctx({ signal: stopped.signal }), [returns], {
  shoot: (html, opts) => (opts.signal?.aborted ? Promise.reject(new Error("stopped")) : shooter(html, opts)),
  look: async (m, s, t, signal) => {
    if (signal?.aborted) throw Object.assign(new Error("The turn was stopped."), { name: "AbortError" });
    return '{"verdict":"pass","issues":[],"fix":null}';
  },
});
check("a turn stopped is skipped, never thrown", gone.verdict === "skipped");
reset();
const broken = await reviewScreens(ctx({ db: null }), [tabbed], { shoot: shooter, look: looker([]) });
check(
  "anything unexpected is skipped, never thrown",
  broken.verdict === "skipped" && logged.some((l) => l.startsWith("[ux] skipped:"))
);

console.log(
  fails.length === 0 ? "\nthe screen check sees what it should, and costs nothing when off" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
