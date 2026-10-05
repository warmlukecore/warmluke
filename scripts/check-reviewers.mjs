// The reviewers around a design: the operator's view before the plan,
// and the gate after the critic (a simpler build, the store's rows, the
// rules tried on them, the screens).
//
// Holds the signs found in code, the readers of the two models' replies
// (fenced, broken, too long, too many), the gate's one line to the
// designer and its cap, that a reviewer which fails is no reviewer, that
// with every switch off nothing is called and nothing is sent that was
// not sent before, and that a turn sends a design back once, critic and
// gate together. Pure: the model is stood in for (fetch), and the
// database by a client that answers nothing, so no store and no rows.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-reviewers.mjs

delete process.env.MODEL_TAPE;
const SWITCHES = [
  "ANTHROPIC_PLAN_MODEL",
  "ANTHROPIC_CRITIC_MODEL",
  "ANTHROPIC_MEMORY_MODEL",
  "ANTHROPIC_REFLECT_MODEL",
  "ANTHROPIC_TALK_MODEL",
  "ANTHROPIC_OPS_MODEL",
  "ANTHROPIC_REVIEW_MODEL",
  "ANTHROPIC_UX_MODEL",
];
for (const k of SWITCHES) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "stand-in";
process.env.ANTHROPIC_API_URL = "https://model.stand-in.test/v1/messages";
process.env.ANTHROPIC_MODEL = "claude-design-stand-in";
process.env.ANTHROPIC_GAP_MODEL = "claude-gap-stand-in";
process.env.TYPESAFE_API_KEY = "";

const { parseOps, opsBlock, parseSimplicity, workaroundSigns } = await import("../src/lib/reviewers.ts");
const { reviewDesign, redoFrom, hasChecks, REDO_MAX } = await import("../src/lib/review-gate.ts");
const { runTurn } = await import("../src/lib/engine.ts");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
// The log lines a failing reviewer writes, kept off the screen.
const logged = [];
console.error = (line) => logged.push(String(line));

// ── The model, stood in for: each job answers by what its instructions say it is.
let answers = {};
let calls = [];
let sent = [];
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(init.body);
  const system = JSON.stringify(body.system ?? "");
  const job = system.includes("You are not designing yet")
    ? "plan"
    : system.includes("You check a design against")
      ? "critic"
      : system.includes("name what they asked for that is missing")
        ? "gap"
        : system.includes("seasoned operator of Indian D2C")
          ? "ops"
          : system.includes("is there a simpler build")
            ? "review"
            : "design";
  calls.push(job);
  sent.push({ job, messages: body.messages ?? [] });
  // A list answers call by call, its last answer once it runs out.
  const all = answers[job];
  const a = Array.isArray(all) ? all[Math.min(calls.filter((c) => c === job).length - 1, all.length - 1)] : all;
  if (a instanceof Error) throw a;
  if (a && typeof a === "object" && "status" in a) return new Response(a.body, { status: a.status });
  return new Response(
    JSON.stringify({
      id: "msg_stand_in",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: a ?? "{}" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
const fresh = (a, env = {}) => {
  answers = a;
  calls = [];
  sent = [];
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
};

// ── Fixtures ────────────────────────────────────────────────────
const ORDERS = { id: "11111111-1111-4111-8111-111111111111", nav_label: "Orders", source_table: "orders" };
const modules = [
  {
    ...ORDERS,
    project_id: "p",
    parent_id: null,
    name: "orders",
    icon: "shopping-cart",
    route: "/orders",
    sort_order: 0,
    created_at: "",
  },
];
const ordersSchema = {
  columns: [
    { field: "order_number", label: "Order", type: "text" },
    { field: "rto", label: "RTO", type: "boolean" },
    { field: "rto_status", label: "RTO status", type: "badge" },
  ],
  features: null,
};
const schemas = new Map([[ORDERS.id, ordersSchema]]);
const plan = (p) => ({
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
const hourlyNo = plan({
  changeType: "AUTOMATION_ADD",
  targetModuleId: ORDERS.id,
  automation: {
    name: "Fill RTO status",
    definition: {
      trigger: { type: "schedule", every: "hourly" },
      actions: [{ type: "set_fields", target: { self: true }, set: { rto_status: { const: "No" } } }],
    },
  },
});

console.log("signs found in code");
check(
  "a schedule that sets fields with no condition",
  /Fill RTO status.*hourly.*every row/.test(workaroundSigns([hourlyNo], modules, schemas).join("\n"))
);
const guarded = plan({
  ...hourlyNo,
  automation: {
    name: "Mark late",
    definition: {
      ...hourlyNo.automation.definition,
      trigger: { type: "schedule", every: "daily", when: { field: "rto" } },
    },
  },
});
check("a schedule with a condition is not one", workaroundSigns([guarded], modules, schemas).length === 0);
const isRto = plan({
  changeType: "FIELD_ADD",
  targetModuleId: ORDERS.id,
  newSchema: { columns: [{ field: "is_rto", label: "Is RTO", type: "boolean" }] },
});
const tangle = workaroundSigns([isRto], modules, schemas).join("\n");
check(
  "three yes/no or status fields for one word, the section's own counted",
  /Orders would have 3 .*"rto"/.test(tangle)
);
check(
  "a new field meaning one already there, by its name",
  /"is_rto" on Orders means the same as "rto", already there/.test(tangle)
);
const flag = plan({
  changeType: "FIELD_ADD",
  targetModuleId: ORDERS.id,
  newSchema: { columns: [{ field: "rto_flag", label: "RTO?", type: "text" }] },
});
check(
  "rto_flag reads as rto",
  /"rto_flag" on Orders means the same as "rto"/.test(workaroundSigns([flag], modules, schemas).join("\n"))
);
const showing = (html) =>
  plan({
    changeType: "FEATURE_UPDATE",
    targetModuleId: ORDERS.id,
    features: { tabs: [{ type: "custom", title: "RTO list", html }] },
  });
check(
  "a written screen that only shows rows",
  /"RTO list" on Orders only shows rows/.test(
    workaroundSigns(
      [showing("<div id=l></div><script>wl.onRows(r=>l.textContent=r.length)</script>")],
      modules,
      schemas
    ).join("\n")
  )
);
check(
  "one that writes is not",
  workaroundSigns(
    [showing("<script>wl.onRows(r=>{});async function tick(id){await wl.set(id,{rto:true})}</script>")],
    modules,
    schemas
  ).length === 0
);
const twoTables = plan({
  changeType: "FEATURE_UPDATE",
  targetModuleId: ORDERS.id,
  features: { tabs: [{ type: "table", label: "Simple table" }] },
});
check(
  "a table tab beside the section's own table",
  /Orders would show the same rows as a table twice/.test(workaroundSigns([twoTables], modules, schemas).join("\n"))
);
const clean = plan({
  changeType: "NEW_MODULE",
  newModule: { name: "returns", nav_label: "Returns", icon: "undo-2" },
  newSchema: {
    columns: [
      { field: "order_number", label: "Order", type: "text" },
      { field: "rto", label: "RTO", type: "boolean" },
    ],
  },
  features: { view: { type: "table" }, stats: [{ label: "RTO", op: "count", where: { field: "rto" } }] },
});
const onChange = plan({
  changeType: "AUTOMATION_ADD",
  targetModuleId: "#returns",
  automation: {
    name: "Stamp RTO",
    definition: {
      trigger: { type: "record_updated", when: { field: "rto" } },
      actions: [{ type: "set_fields", target: { self: true }, set: { rto_at: { op: "now" } } }],
    },
  },
});
check("a clean design has no signs", workaroundSigns([clean, onChange], modules, schemas).length === 0);

console.log("\nthe operator's reply, read back");
const view = parseOps(
  '```json\n{"ideas":[{"idea":"Call NDRs within a day","why":"saves the RTO","from_data":"312 undelivered"},{"idea":"b"},{"idea":"c"}],"watch_out":["courier lags","x","y"]}\n```'
);
check("fenced, cut to two ideas and two warnings", view?.ideas.length === 2 && view.watch_out.length === 2);
check("each field kept", view?.ideas[0].from_data === "312 undelivered" && view.ideas[1].why === "");
check(
  "an idea is cut to 200 characters",
  parseOps(JSON.stringify({ ideas: [{ idea: "x".repeat(500) }] }))?.ideas[0].idea.length === 200
);
check(
  "an idea with no words is dropped",
  parseOps('{"ideas":[{"why":"w"},"text"],"watch_out":[3]}')?.ideas.length === 0
);
check("not JSON, no view", parseOps("I would call the NDRs.") === null);
check("a list, no view", parseOps("[1]") === null);
check("nothing to add is no block", opsBlock(parseOps('{"ideas":[],"watch_out":[]}')) === "" && opsBlock(null) === "");
const block = opsBlock(view);
check(
  "the block asks for a sentence in say, never a build unasked",
  block.startsWith("\n\nAN OPERATOR WHO KNOWS STORES LIKE THIS SUGGESTS") && /never build it unasked/.test(block)
);
check(
  "and carries the idea, why, and the data",
  /- Call NDRs within a day — saves the RTO \(their data: 312 undelivered\)/.test(block)
);

console.log("\nthe simplicity reviewer's reply, read back");
check(
  "simple has no redo",
  JSON.stringify(parseSimplicity('{"verdict":"simple","redo":"x","why":"fine"}')) ===
    '{"verdict":"simple","redo":null,"why":"fine"}'
);
check(
  "redo names the simpler way",
  parseSimplicity('```\n{"verdict":"redo","redo":"Use the rto tick","why":"same fact"}\n```')?.redo ===
    "Use the rto tick"
);
check("a redo that names nothing is no verdict", parseSimplicity('{"verdict":"redo","redo":"  ","why":"w"}') === null);
check("another verdict is none", parseSimplicity('{"verdict":"maybe"}') === null);
check("not JSON is none", parseSimplicity("Looks simple.") === null);
const long = parseSimplicity(JSON.stringify({ verdict: "redo", redo: "r".repeat(900), why: "w".repeat(900) }));
check("lines are cut", long?.redo.length === 400 && long.why.length === 300);

console.log("\nthe gate's line to the designer");
const nothing = { simplicity: null, data: [], dryRuns: [], ux: null };
check("nothing wrong, nothing sent", redoFrom(nothing, []) === null);
const dryAll = {
  plan: 0,
  rule: "Fill RTO status",
  section: "Orders",
  matched: 2353,
  of: 2353,
  sample: [],
  note: null,
  everyRow: true,
};
const all = redoFrom(
  {
    simplicity: { verdict: "redo", redo: "Use the rto tick; drop rto_status", why: "" },
    data: [
      { plan: 0, text: "No order says RTO; the store says rto_initiated", severity: "problem" },
      { plan: 0, text: "412 orders this month", severity: "note" },
    ],
    dryRuns: [dryAll, { ...dryAll, rule: "Flag repeat", matched: 23, of: 412, everyRow: false }],
    ux: {
      verdict: "redo",
      how: "text",
      issues: ["the list overflows at 390px"],
      fix: "Use the section's table",
      ms: 0,
    },
  },
  [hourlyNo]
);
check("the simpler way, under its header", (all ?? "").startsWith("SIMPLER: Use the rto tick"));
check(
  "a data problem, not a note",
  /Checked against their own rows:\n- No order says RTO/.test(all ?? "") && !/412 orders/.test(all ?? "")
);
check(
  "a schedule writing one value into every row",
  /Rule "Fill RTO status" would rewrite all 2353 rows of Orders every run/.test(all ?? "") &&
    !/Flag repeat/.test(all ?? "")
);
check(
  "the screen's fix and its issues",
  /The screen, looked at: Use the section's table\n- the list overflows/.test(all ?? "")
);
check(
  "every row touched by a rule on a change is not a rewrite",
  redoFrom({ ...nothing, dryRuns: [dryAll] }, [onChange]) === null
);
const capped = redoFrom(
  {
    ...nothing,
    data: Array.from({ length: 40 }, (_, i) => ({
      plan: 0,
      text: `problem ${i} ${"x".repeat(80)}`,
      severity: "problem",
    })),
  },
  []
);
check(`cut to ${REDO_MAX} characters`, capped?.length === REDO_MAX && capped.endsWith("…"));
check(
  "a pass and a note are not sent back",
  redoFrom({ ...nothing, ux: { verdict: "pass", how: "text", issues: [], fix: "x", ms: 0 } }, []) === null
);

console.log("\nthe gate, switched");
const ctx = {
  db: null,
  projectId: "p",
  store: null,
  modules,
  schemas,
  ownerWords: "Track RTO on orders",
  understood: "",
  locale: "en-IN",
  currency: "INR",
  uxModel: null,
};
const told = [];
fresh({});
const off = await reviewDesign(ctx, [isRto], {
  tell: (s) => told.push(s),
  describe: "Add fields to Orders",
  columnLines: [],
});
check("every switch off: no model is called", calls.length === 0);
check(
  "nothing to send back, nothing to show, nothing told",
  off.redo === null && !hasChecks(off.checks) && told.length === 0
);

fresh(
  { review: '{"verdict":"redo","redo":"Use the rto tick already there","why":"same fact"}' },
  { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const on = await reviewDesign(ctx, [isRto], {
  tell: (s) => told.push(s),
  describe: "Add fields to Orders",
  columnLines: ["- Orders: rto (boolean)"],
});
check("the reviewer is called once, on its own job", calls.join() === "review");
check(
  "and handed the signs as facts",
  /SIGNS THE CODE FOUND:\n- .*is_rto/.test(sent[0].messages[0].content[0]?.text ?? JSON.stringify(sent[0].messages))
);
check("its redo goes back", on.redo === "SIMPLER: Use the rto tick already there");
check("and stays on the card", on.checks.simplicity?.verdict === "redo" && on.checks.simplicity.why === "same fact");
check(
  "told as a step",
  told.some((s) => s.step === "simplicity" && s.verdict === "redo")
);

fresh(
  { review: { status: 500, body: '{"type":"error","error":{"type":"api_error","message":"down"}}' } },
  { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const down = await reviewDesign(ctx, [isRto], { tell: () => {}, describe: "", columnLines: [] });
check("a reviewer whose model fails is no reviewer", down.redo === null && down.checks.simplicity === null);
fresh({ review: '{"verdict":"redo","redo":"x","why":"y"}' }, { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" });
const thrown = await reviewDesign(ctx, [null], {
  tell: () => {
    throw new Error("listener");
  },
  describe: "",
  columnLines: [],
});
check(
  "one that throws is ignored, and the gate never throws",
  thrown.redo === null && thrown.checks.simplicity === null
);
check(
  "said in the log",
  logged.some((l) => l.startsWith("[review]"))
);

// ── The loop, driven: a client that answers nothing (no store, no rows).
const db = new Proxy(function () {}, {
  get: (_, key) => (key === "then" ? (resolve) => resolve({ data: null, error: null }) : () => db),
  apply: () => db,
});
const project = {
  id: "p",
  owner_id: "u",
  name: "Shop",
  description: null,
  locale: "en-IN",
  currency: "INR",
  created_at: "",
};
const DESIGN = JSON.stringify({
  type: "blueprint",
  title: "Returns",
  message: "A returns list with a tick for RTO.",
  blueprint: {
    summary: "A section for returns, each with an RTO tick.",
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "returns", nav_label: "Returns", icon: "table" },
        newSchema: { columns: [{ field: "rto", label: "RTO", type: "boolean" }] },
        features: { view: { type: "table" } },
        newRecords: null,
        explanation: "Somewhere to keep each return and whether it came back.",
      },
    ],
    workflow: [],
    unmet: [],
    next: [],
  },
});
const PLAN = (say) =>
  JSON.stringify({
    goal: "Mark returns that came back RTO",
    rows: "a returns list",
    work: [],
    facts: [],
    rules: [],
    screens: [],
    unsure: [],
    say,
  });
const turn = async (message = "Add a returns list with a tick for RTO", history = []) => {
  const steps = [];
  const r = await runTurn({
    client: db,
    project,
    modules: [],
    message,
    history,
    lookups: true,
    onEvent: (e) => steps.push(e),
  });
  return { r, steps };
};
const designs = () => calls.filter((c) => c === "design").length;
const lastUser = (s) => {
  const m = s.messages.filter((x) => x.role === "user").at(-1);
  return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");
};

console.log("\noff means off, in a whole turn");
fresh({ design: DESIGN, gap: '{"unmet": []}' });
const plain = await turn();
check("only the design and the gap pass are called", calls.join() === "design,gap");
check("the design is sent exactly the turn, nothing added", lastUser(sent[0]) === plain.r.userTurn);
check("the reply carries no checks", plain.r.ok && plain.r.reply.checks === undefined);
check(
  "no reviewer's step is told",
  !plain.steps.some((s) => ["ops", "simplicity", "data", "dryrun", "ux"].includes(s.step))
);

console.log("\nnew sections drawn as bare plans are shown as the card to approve");
const PLANS = JSON.stringify({ type: "plans", message: "A returns list.", plans: JSON.parse(DESIGN).blueprint.plans });
fresh({ design: PLANS, gap: '{"unmet": []}' });
const wrapped = await turn();
check(
  "not sent back to be wrapped: one design call, and a card (4 Oct)",
  designs() === 1 && wrapped.r.ok && wrapped.r.reply.type === "blueprint"
);
check(
  "the card holds the same plans and says what the design said",
  wrapped.r.ok &&
    wrapped.r.reply.blueprint.plans[0]?.newModule?.name === "returns" &&
    wrapped.r.reply.message === "A returns list."
);
check("and it is not marked agreed", wrapped.r.ok && !wrapped.r.reply.approved);

console.log("\none redo a turn, critic and gate together");
fresh(
  {
    design: DESIGN,
    gap: '{"unmet": []}',
    review: '{"verdict":"redo","redo":"Use the store\'s own returns","why":"same rows"}',
  },
  { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const gateOnly = await turn();
check(
  "the gate sends it back once, and only once",
  designs() === 2 && calls.filter((c) => c === "review").length === 2
);
check(
  "the redo carries the simpler way",
  /reviewed before the owner sees it[\s\S]*SIMPLER: Use the store's own returns/.test(
    lastUser(sent.filter((s) => s.job === "design")[1])
  )
);
check(
  "the design that came back carries its checks",
  gateOnly.r.ok && gateOnly.r.reply.checks?.simplicity?.verdict === "redo"
);
check("a gate's redo is not called the critic's", gateOnly.r.ok && gateOnly.r.criticRedo === false);

// Two repairs used to leave no attempt for it: the reviewers read a
// written screen and could not send it back (returns eval, 4 Oct).
const REFUSED = '{"type":"plans","plans":[{"changeType":"NEW_MODULE","targetModuleId":null}]}';
fresh(
  {
    design: [REFUSED, REFUSED, DESIGN],
    gap: '{"unmet": []}',
    review: '{"verdict":"redo","redo":"Use the store\'s own returns","why":"same rows"}',
  },
  { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const late = await turn();
check("after two repairs the gate can still send it back, once", designs() === 4 && late.r.ok);
check(
  "and the redo is told why",
  /reviewed before the owner sees it/.test(lastUser(sent.filter((s) => s.job === "design")[3]))
);
check(
  "and to send the whole design, not the part that changes (4 Oct)",
  /every plan, as if sent for the first time/.test(lastUser(sent.filter((s) => s.job === "design")[3]))
);

fresh(
  {
    plan: PLAN(""),
    design: DESIGN,
    critic: '{"unmet": ["the RTO count"], "redo": "Add a count of RTO returns."}',
    review: '{"verdict":"redo","redo":"Drop the tab","why":"same rows"}',
  },
  { ANTHROPIC_PLAN_MODEL: "claude-plan-stand-in", ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const both = await turn();
check("the critic sends it back; the gate after it cannot send it again", designs() === 2);
check("the gate does not read the design the critic sent back", calls.filter((c) => c === "review").length === 1);
check("the critic's redo is still the critic's", both.r.ok && both.r.criticRedo === true);

console.log("\na design their AI drew goes through what Luke's do (5 Oct)");
const drawn = async (design) => {
  const steps = [];
  const r = await runTurn({
    client: db,
    project,
    modules: [],
    message: "Add a returns list with a tick for RTO",
    history: [],
    plansAllowed: true,
    reviewed: true,
    givenDesign: design,
    onEvent: (e) => steps.push(e),
  });
  return { r, steps };
};
fresh({ design: DESIGN, gap: '{"unmet": []}' });
const holds = await drawn(DESIGN);
check("one that holds needs no model to draw it", designs() === 0 && holds.r.ok && holds.r.repairs === 0);
fresh(
  {
    design: DESIGN,
    gap: '{"unmet": []}',
    review: '{"verdict":"redo","redo":"Use the store\'s own returns","why":"same rows"}',
  },
  { ANTHROPIC_REVIEW_MODEL: "claude-review-stand-in" }
);
const reviewedOnce = await drawn(DESIGN);
check(
  "the reviewers read it, and Luke redraws what they send back",
  calls.includes("review") && designs() === 1 && reviewedOnce.r.ok
);
check(
  "Luke's redraw is handed their design to start from",
  sent
    .find((s) => s.job === "design")
    ?.messages.some(
      (m) => m.role === "assistant" && JSON.stringify(m.content).includes("A returns list with a tick for RTO")
    )
);
check(
  "and the turn says what it was sent back for",
  reviewedOnce.r.ok && /Use the store's own returns/.test(reviewedOnce.r.sentBackWhy ?? "")
);
fresh({ design: DESIGN, gap: '{"unmet": []}' });
const repaired = await drawn(REFUSED);
check("one the validator refuses, Luke repairs", designs() === 1 && repaired.r.ok && repaired.r.repairs === 1);

console.log("\nthe operator's view, before the plan");
fresh(
  {
    ops: '{"ideas":[{"idea":"Act on NDRs before they turn RTO","why":"saves the return trip","from_data":""}],"watch_out":[]}',
    plan: PLAN("A tick for RTO on each return. Want me to build it?"),
  },
  { ANTHROPIC_PLAN_MODEL: "claude-plan-stand-in", ANTHROPIC_OPS_MODEL: "claude-ops-stand-in" }
);
const asked = await turn();
check(
  "asked first, then the plan, and nothing designed before a yes",
  calls.join() === "ops,plan" && asked.r.reply.kind === "proposal"
);
check(
  "the plan call reads the idea; the operator never writes the design",
  /AN OPERATOR WHO KNOWS STORES LIKE THIS SUGGESTS[\s\S]*Act on NDRs/.test(lastUser(sent[1]))
);
check(
  "told when it starts and when it is back",
  asked.steps.some((s) => s.step === "ops" && s.ideas === null) &&
    asked.steps.some((s) => s.step === "ops" && s.ideas === 1)
);
fresh(
  { ops: { status: 500, body: "{}" }, plan: PLAN("Want me to build it?") },
  { ANTHROPIC_PLAN_MODEL: "claude-plan-stand-in", ANTHROPIC_OPS_MODEL: "claude-ops-stand-in" }
);
const failed = await turn();
check(
  "a view that fails is no view: the plan is sent the turn alone",
  lastUser(sent.at(-1)) === failed.r.userTurn && logged.some((l) => l.startsWith("[ops]"))
);
fresh(
  { plan: PLAN(""), design: DESIGN, critic: '{"unmet": [], "redo": null}' },
  { ANTHROPIC_PLAN_MODEL: "claude-plan-stand-in", ANTHROPIC_OPS_MODEL: "claude-ops-stand-in" }
);
await turn("Just build it: a returns list with a tick for RTO");
check("not once they said to just build it", !calls.includes("ops"));
fresh({ plan: PLAN("Want me to build it?") }, { ANTHROPIC_PLAN_MODEL: "claude-plan-stand-in" });
const noOps = await turn();
check(
  "switched off, the plan is sent exactly the turn",
  calls.join() === "plan" && lastUser(sent[0]) === noOps.r.userTurn
);

console.log(fails.length === 0 ? "\nthe reviewers read, combine and stay in their place" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
