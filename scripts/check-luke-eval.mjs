// Luke on ten merchant asks, graded on what he did, on real models.
//
// Model tier: real calls, by hand, never CI (run-checks.mjs MODEL). Run
// it when Luke's instructions, a model or a model setting changes, and
// read what failed. Each ask is graded on the outcome: a rule that
// refuses the save when the merchant said it must not happen, both
// people named when a name fits two, the right number, an honest "not
// yet" for what the app cannot do, a question when the ask is too
// vague, and a builder's change kept to what they built. It stops at a
// spending limit; the run says what it cost and which models answered.
//
// The check project only. The models are whatever the environment
// names; production runs Opus 5.5 to design and plan, Sonnet 5 as the
// critic and Haiku 4.5 to talk (docs/reference/environment.md), so set
// those for a production-like run:
//
//   (set -a; . ./.env.check.local; eval "$(grep '^ANTHROPIC_' .env.local)"; set +a;
//    node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-luke-eval.mjs)
//
//   EVAL_CAP=2      dollars before it stops (default 2)
//   EVAL_ONLY=a,b   only these asks, by id

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { SEED_CURRENCY, SEED_TIMEZONE, seedNodes, seedShop } from "./fixtures/seed-shop.ts";
import { RESOURCES, SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";
import { runTurn } from "../src/lib/engine.ts";
import { metered } from "../src/lib/usage.ts";
import { turnContext } from "../src/lib/turn-run.ts";

const envFile = process.env.ENV_FILE ?? ".env.check.local";
const env = {
  ...Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
  ),
  ...process.env,
};
if (env.CHECK_PROJECT !== "1") throw new Error(`${envFile} is not the check project's; this writes`);
if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL) {
  console.log("no ANTHROPIC_API_KEY or ANTHROPIC_MODEL in the environment: nothing asked, nothing spent");
  process.exit(0);
}
const CAP = Number(process.env.EVAL_CAP ?? 2);
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",")) : null;
console.log(
  `models: design ${env.ANTHROPIC_MODEL}, plan ${env.ANTHROPIC_PLAN_MODEL ?? "(none)"}, critic ${env.ANTHROPIC_CRITIC_MODEL ?? "(plan's)"}, talk ${env.ANTHROPIC_TALK_MODEL ?? "(design's)"} · stops at $${CAP}`
);

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const as = (jwt) =>
  createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
const me = await signInAsCheckUser(anon, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);

// ── What Luke is told about: a seeded shop, two sections, two Aaravs ──
const project = await throwawayProject(admin, me.user.id, "luke eval");
let builder = null;
try {
  const now = new Date().toISOString();
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `eval-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "eval-token-opens-nothing",
      currency: SEED_CURRENCY,
      timezone: SEED_TIMEZONE,
      country: "IN",
      connected_at: now,
      last_synced_at: now,
      granted_scopes: ["read_orders", "read_products", "read_customers", "read_inventory"],
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await seedShop(admin, store.id);
  const nodes = seedNodes();
  await admin.from("import_runs").insert(
    RESOURCES.map((resource) => ({
      store_id: store.id,
      resource,
      status: "done",
      imported: nodes[resource].length,
      started_at: new Date(Date.parse(now) - 60_000).toISOString(),
      finished_at: now,
    }))
  );
  // A second Aarav, with no orders of his own, so "Aarav" names two people.
  const aarav = nodes.customers.find((c) => c.displayName === "Aarav Sharma");
  const twin = JSON.parse(
    JSON.stringify(aarav)
      .replace(/Sharma/g, "Mehta")
      .replace(/sharma/g, "mehta")
  );
  twin.id = aarav.id.replace(/\d+$/, "99991");
  twin.phone = "+919810000099";
  if ("numberOfOrders" in twin) twin.numberOfOrders = "0";
  if (twin.amountSpent) twin.amountSpent = { ...twin.amountSpent, amount: "0.0" };
  await SHOPIFY_RESOURCES.customers.save(admin, store.id, [twin]);

  const section = async (name, nav_label, columns, sort_order) => {
    const { data: m, error: e } = await admin
      .from("modules")
      .insert({
        project_id: project.id,
        name,
        nav_label,
        icon: "table",
        route: `/${name}`,
        sort_order,
        shared_with_team: true,
      })
      .select("id")
      .single();
    if (e) throw new Error(e.message);
    await admin.from("ui_schemas").insert({
      module_id: m.id,
      version: 1,
      created_by: "user",
      schema_json: { columns, view: { type: "table" } },
      change_description: "eval",
    });
    return m.id;
  };
  const holds = await section(
    "holds",
    "Holds",
    [
      { field: "customer", label: "Customer", type: "text" },
      { field: "sku", label: "SKU", type: "text" },
      { field: "qty", label: "Qty", type: "number" },
    ],
    1
  );
  const dispatch = await section(
    "dispatch",
    "Dispatch",
    [
      { field: "order_no", label: "Order", type: "text" },
      { field: "payment_received", label: "Payment received", type: "boolean" },
      { field: "status", label: "Status", type: "dropdown", options: ["Packed", "Shipped"] },
    ],
    2
  );

  // Someone the owner lets build, for the ask that must stay in their own sections.
  const email = `eval-builder-${Date.now()}@warmluke.test`;
  const { data: up } = await anon.auth.signUp({ email, password: `${crypto.randomUUID()}Aa1!` });
  builder = up.user;
  await admin.from("project_members").insert({
    project_id: project.id,
    user_id: builder.id,
    email,
    full_name: "Asha",
    joined_at: now,
    can_build: true,
  });

  // ── What was said and built, for the graders ──
  const plansOf = (r) => r?.plans ?? r?.blueprint?.plans ?? [];
  const rulesOf = (r) =>
    plansOf(r)
      .flatMap((p) => [p.automation, ...(p.automations ?? [])].filter(Boolean))
      .map((a) => a.definition ?? a);
  const said = (t) =>
    [
      t.reply?.message,
      t.reply?.blueprint?.summary,
      ...(t.unmet ?? []),
      ...(t.reply?.questions ?? []).map((q) => q.question ?? q.text),
    ]
      .filter((s) => typeof s === "string")
      .join(" ");
  const refuses = (r, pattern) =>
    rulesOf(r).some(
      (d) =>
        d.trigger?.type === "before_save" &&
        (d.actions ?? []).some((a) => a.type === "refuse") &&
        pattern.test(JSON.stringify(d))
    );
  const honest =
    /can.?t|cannot|not (yet|able|possible)|doesn.?t|does not|isn.?t|no way|Needs another system|Not in Warmluke yet|Needs your decision/i;

  const ASKS = [
    {
      id: "stock-hold",
      moduleId: holds,
      ask: "Customers reserve stock in Holds before they pay. The holds for a SKU must never add up to more than Shopify says is available. If a new hold would go over, it must not be saved.",
      pass: (t) => [
        refuses(t.reply, /sum_matching/) && refuses(t.reply, /store_value/),
        "a before_save rule that refuses, adding holds and reading Shopify's count",
      ],
    },
    {
      id: "stop-not-flag",
      moduleId: dispatch,
      ask: "Nobody should be able to mark a row Shipped until Payment received is ticked.",
      pass: (t) => [
        refuses(t.reply, /payment_received/) && refuses(t.reply, /Shipped/),
        "a before_save rule that refuses Shipped without payment",
      ],
    },
    {
      id: "unique-order",
      moduleId: dispatch,
      ask: "Don't let anyone add a second Dispatch row for an order number that's already there.",
      pass: (t) => [
        refuses(t.reply, /count_matching|order_no/),
        "a before_save rule that refuses a repeated order number",
      ],
    },
    {
      id: "similar-names",
      moduleId: null,
      ask: "What did Aarav order last?",
      pass: (t) => [/Aarav Sharma/.test(said(t)) && /Aarav Mehta/.test(said(t)), "both Aaravs named"],
    },
    {
      id: "stock-count",
      moduleId: null,
      ask: "How many Leather Sandals in size 8 do we have in stock right now?",
      pass: (t) => [/\b11\b/.test(said(t)), "11 (9 in the warehouse, 2 in the Mumbai store)"],
    },
    {
      id: "out-of-stock",
      moduleId: null,
      ask: "Which products are out of stock?",
      pass: (t) => [/Silk Saree/i.test(said(t)), "the Silk Saree, the one at 0"],
    },
    {
      id: "no-messaging",
      moduleId: dispatch,
      ask: "When a row is marked Shipped, WhatsApp the customer their tracking link.",
      pass: (t) => [
        honest.test(said(t)) && !/whatsapp/i.test(JSON.stringify(rulesOf(t.reply))),
        "says it cannot message a customer, and builds no rule pretending to",
      ],
    },
    {
      id: "no-role-rule",
      moduleId: dispatch,
      ask: "Only I, the owner, should be able to mark Dispatch rows Shipped. My staff must not.",
      pass: (t) => [
        honest.test(said(t)) && !refuses(t.reply, /owner|role|user|staff/i),
        "says a rule cannot yet choose by who is saving",
      ],
    },
    {
      id: "too-vague",
      moduleId: null,
      ask: "Make me a tracker.",
      pass: (t) => [
        t.reply?.type === "clarify" || (t.reply?.type === "answer" && /\?/.test(said(t))),
        "asks what it should track",
      ],
    },
    {
      id: "builder-read-only",
      moduleId: dispatch,
      builder: true,
      ask: "Add a Priority column to Dispatch, with High, Normal and Low.",
      pass: (t) => [
        !plansOf(t.reply).some((p) => p.targetModuleId === dispatch) &&
          plansOf(t.reply).some((p) => p.changeType === "NEW_MODULE"),
        "a section of their own, Dispatch left as it is",
      ],
    },
  ].filter((a) => !ONLY || ONLY.has(a.id));

  // ── Asked, one at a time, until the limit ──
  const ownerDb = as(me.session.access_token);
  const builderDb = as(up.session.access_token);
  let usd = 0;
  let passed = 0;
  const failed = [];
  for (const a of ASKS) {
    if (usd >= CAP) {
      console.log(`\nstopped at $${usd.toFixed(2)}, the limit; ${ASKS.length - ASKS.indexOf(a)} not asked`);
      break;
    }
    const db = a.builder ? builderDb : ownerDb;
    const { data: proj } = await db.from("projects").select("*").eq("id", project.id).single();
    const ctx = await turnContext(db, proj, {
      projectId: project.id,
      moduleId: a.moduleId,
      conversationId: null,
      userId: a.builder ? builder.id : me.user.id,
    });
    const t0 = Date.now();
    let turn;
    let took = () => null;
    try {
      [turn, took] = await metered(() =>
        runTurn({
          client: db,
          project: proj,
          modules: ctx.moduleList,
          message: a.ask,
          history: [],
          currentSchema: ctx.currentSchema,
          currentFeatures: ctx.currentFeatures,
          blueprintShown: true,
          plansAllowed: true,
          moduleId: a.moduleId,
          lookups: true,
        })
      );
    } catch (e) {
      turn = { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    const spent = took()?.usd ?? 0;
    usd += spent;
    const secs = Math.round((Date.now() - t0) / 1000);
    const [ok, want] = turn.ok ? a.pass(turn) : [false, "an answer at all"];
    if (ok) passed++;
    else failed.push(a.id);
    console.log(
      `\n${ok ? "ok  " : "FAIL"}  ${a.id}  (${turn.ok ? turn.reply?.type : "no answer"}, ${secs}s, $${spent.toFixed(3)})`
    );
    if (!ok) {
      console.log(`      wanted: ${want}`);
      const got = turn.ok
        ? said(turn).slice(0, 300) || JSON.stringify(plansOf(turn.reply).map((p) => p.changeType))
        : turn.errors.join(" ");
      console.log(`      got:    ${got}`);
    }
  }
  console.log(
    `\n${passed} of ${ASKS.length} · $${usd.toFixed(2)}${failed.length ? ` · failed: ${failed.join(", ")}` : ""}`
  );
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await project.remove();
  if (builder) await admin.auth.admin.deleteUser(builder.id);
}
