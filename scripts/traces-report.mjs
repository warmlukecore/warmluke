// A week of turns, read as a whole (0132).
//
// What the traces say: how many turns each road took and how long, how
// often a design needed repairing and what the grammar refused, how
// often the critic sent one back, what it all cost. The numbers a
// prompt or a grammar change is judged by, before and after.
//
//   ENV_FILE=.env.check.local node scripts/traces-report.mjs            (the check project)
//   node scripts/traces-report.mjs --days 7                             (production: .env.local)
//   node scripts/traces-report.mjs --project <uuid>

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const days = Number(flag("--days", "7"));
const project = flag("--project", null);

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - days * 86_400_000).toISOString();
let q = db
  .from("turn_traces")
  .select("road, model, steps, usage, repairs, repair_errors, unmet, plan_goal, critic, took_ms, created_at")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(2000);
if (project) q = q.eq("project_id", project);
const { data: rows, error } = await q;
if (error) throw new Error(error.message);
if (!rows?.length) {
  console.log(`no turns in the last ${days} days${project ? " for that project" : ""}`);
  process.exit(0);
}

const ms = (n) => `${(n / 1000).toFixed(1)}s`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`${rows.length} turns in the last ${days} days${project ? " (one project)" : ""}\n`);

console.log("by road");
for (const road of ["talk", "design", null]) {
  const on = rows.filter((r) => r.road === road);
  if (!on.length) continue;
  const took = on.map((r) => r.took_ms ?? 0);
  const usd = on.map((r) => r.usage?.usd ?? 0);
  console.log(
    `  ${(road ?? "unknown").padEnd(8)} ${String(on.length).padStart(4)} turns · median ${ms(median(took))} · mean ${ms(avg(took))} · $${avg(usd).toFixed(3)} a turn`
  );
}

const designs = rows.filter((r) => r.road === "design");
if (designs.length) {
  console.log("\ndesigns");
  const repaired = designs.filter((r) => (r.repairs ?? 0) > 0).length;
  console.log(`  repaired: ${repaired} of ${designs.length} (${Math.round((100 * repaired) / designs.length)}%)`);
  const planned = designs.filter((r) => r.plan_goal).length;
  console.log(`  planned first: ${planned} of ${designs.length}`);
  const judged = designs.filter((r) => r.critic);
  const sentBack = judged.filter((r) => r.critic?.verdict === "redo").length;
  console.log(`  read by the critic: ${judged.length}; sent back: ${sentBack}`);
  const unmet = designs.filter((r) => Array.isArray(r.unmet) && r.unmet.length).length;
  console.log(`  left something unmet: ${unmet}`);

  // What the grammar refuses most: the first sentence of each error, counted.
  const refused = new Map();
  for (const r of designs)
    for (const e of Array.isArray(r.repair_errors) ? r.repair_errors : []) {
      const head = String(e)
        .replace(/"[^"]*"/g, '"…"')
        .split(/[.:]/)[0]
        .trim()
        .slice(0, 90);
      refused.set(head, (refused.get(head) ?? 0) + 1);
    }
  if (refused.size) {
    console.log("\n  what the validator refused, most first");
    for (const [what, n] of [...refused.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 12))
      console.log(`    ${String(n).padStart(3)}  ${what}`);
  }

  const attempts = designs.map((r) => (Array.isArray(r.steps) ? r.steps.filter((s) => s.step === "model").length : 0));
  if (attempts.length)
    console.log(`\n  model attempts a design: mean ${avg(attempts).toFixed(2)}, most ${Math.max(...attempts)}`);
}

console.log("\nmodels");
const byModel = new Map();
for (const r of rows)
  for (const u of r.usage?.uses ?? []) {
    const k = `${String(u.job).padEnd(7)} ${u.model}`;
    const m = byModel.get(k) ?? { calls: 0, usd: 0, input: 0 };
    m.calls += u.calls ?? 1;
    m.usd += u.usd ?? 0;
    m.input += u.input ?? 0;
    byModel.set(k, m);
  }
for (const [k, m] of [...byModel.entries()].toSorted((a, b) => b[1].usd - a[1].usd))
  console.log(
    `  ${k.padEnd(40)} ${String(m.calls).padStart(5)} calls · ${Math.round(m.input / Math.max(m.calls, 1)).toLocaleString()} in a call · $${m.usd.toFixed(2)}`
  );
