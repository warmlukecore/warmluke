// Scout, measured (6 Oct): four asks that build on the store's own lists,
// on real models, each once, graded on what Scout is for: how many tries a
// design took (the validator's repairs), how many of those named a field
// that is not there, the time and the dollars. Run it once per setting and
// compare: LUKE_SCOUT=off for the baseline, ANTHROPIC_DESIGN_EFFORT for how
// hard the design is thought through.
//
// Model tier: real calls, by hand, never CI (run-checks.mjs MODEL). The
// check project only. Production's models for a production-like run
// (docs/reference/environment.md): Opus 5.5 designing and planning, Sonnet
// 5 as critic, Haiku 4.5 to talk and for the gap pass.
//
//   EVAL_CAP=0.85   dollars before it stops (default 0.85)
//   EVAL_ONLY=a,b   only these asks, by id

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { SEED_CURRENCY, SEED_TIMEZONE, seedNodes, seedShop } from "./fixtures/seed-shop.ts";
import { RESOURCES } from "../src/lib/shopify-resources.ts";
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
const CAP = Number(process.env.EVAL_CAP ?? 0.85);
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",")) : null;
console.log(
  `models: design ${env.ANTHROPIC_MODEL} at ${env.ANTHROPIC_DESIGN_EFFORT || "medium"}, plan ${env.ANTHROPIC_PLAN_MODEL ?? "(none)"}, critic ${env.ANTHROPIC_CRITIC_MODEL ?? "(plan's)"} · scout ${process.env.LUKE_SCOUT === "off" ? "OFF" : "on"} · stops at $${CAP}`
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
const ownerDb = as(me.session.access_token);

// ── What Luke is told about: the seeded shop, and nothing else ──
const project = await throwawayProject(admin, me.user.id, "scout eval");
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
  const ASKS = [
    {
      id: "cod-unpaid",
      ask: "On my orders, add a Called tick and show me only the cash on delivery orders that are still unpaid, with a count of how many are left to call. Build it.",
    },
    {
      id: "pack-paid",
      ask: "Make a packing list over my orders: a Packed tick beside each order, and a view of the paid orders not packed yet, newest first. Build it.",
    },
    {
      id: "low-stock",
      ask: "On my stock, flag anything with 5 or fewer available and show those first. Build it.",
    },
    {
      id: "city-chart",
      ask: "Show my orders by shipping city as a chart, with the total for each city. Build it.",
    },
  ].filter((a) => !ONLY || ONLY.has(a.id));

  const NAMED_WRONG =
    /doesn't exist|does not exist|not a column|is not one of|columns are:|no such field|unknown field/i;
  const plansOf = (r) => r?.plans ?? r?.blueprint?.plans ?? [];
  let usd = 0;
  const rows = [];
  for (const a of ASKS) {
    // Stops before an ask that could take it past the cap: a turn is counted at its dearest, $0.30.
    if (usd + 0.3 > CAP) {
      console.log(`\nstopped at $${usd.toFixed(2)}, the limit; ${ASKS.length - ASKS.indexOf(a)} not asked`);
      break;
    }
    const { data: proj } = await ownerDb.from("projects").select("*").eq("id", project.id).single();
    const ctx = await turnContext(ownerDb, proj, {
      projectId: project.id,
      moduleId: null,
      conversationId: null,
      userId: me.user.id,
    });
    const t0 = Date.now();
    let turn;
    let took = () => null;
    try {
      [turn, took] = await metered(() =>
        runTurn({
          client: ownerDb,
          project: proj,
          modules: ctx.moduleList,
          message: a.ask,
          history: [],
          currentSchema: ctx.currentSchema,
          currentFeatures: ctx.currentFeatures,
          blueprintShown: true,
          plansAllowed: true,
          moduleId: null,
          lookups: true,
        })
      );
    } catch (e) {
      turn = { ok: false, errors: [e instanceof Error ? e.message : String(e)], repairs: 0, repairErrors: [] };
    }
    const spent = took()?.usd ?? 0;
    usd += spent;
    const row = {
      id: a.id,
      built: turn.ok && plansOf(turn.reply).length > 0,
      type: turn.ok ? turn.reply?.type : "failed",
      tries: 1 + (turn.repairs ?? 0),
      wrongNames: (turn.repairErrors ?? []).filter((e) => NAMED_WRONG.test(e)).length,
      secs: Math.round((Date.now() - t0) / 1000),
      usd: spent,
    };
    rows.push(row);
    console.log(
      `${row.built ? "built" : "NOT BUILT"}  ${a.id}  (${row.type}, ${row.tries} ${row.tries === 1 ? "try" : "tries"}, ${row.wrongNames} wrong names, ${row.secs}s, $${spent.toFixed(3)})`
    );
    for (const e of turn.repairErrors ?? []) console.log(`      repaired: ${e.slice(0, 160)}`);
    if (!turn.ok) console.log(`      ${turn.errors.join(" ").slice(0, 200)}`);
  }
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  console.log(
    `\nRESULT ${JSON.stringify({
      scout: process.env.LUKE_SCOUT === "off" ? "off" : "on",
      effort: env.ANTHROPIC_DESIGN_EFFORT || "medium",
      asked: rows.length,
      built: rows.filter((r) => r.built).length,
      tries: sum("tries"),
      firstTry: rows.filter((r) => r.tries === 1).length,
      wrongNames: sum("wrongNames"),
      secs: sum("secs"),
      usd: Number(usd.toFixed(3)),
    })}`
  );
} finally {
  await admin.from("projects").delete().eq("id", project.id);
}
