// Asserts the three expression evaluators agree on the operator set:
// the registry (src/lib/capabilities.ts), the browser evaluator
// (src/lib/expr.ts) and the Postgres one (migration 0010).
//
// The Postgres evaluator cannot be generated from TypeScript, so this
// is the check that keeps that seam from drifting: every operator the
// assistant is told about must actually evaluate in the database.
//
//   node scripts/check-operator-parity.mjs
// Needs SUPABASE_DB_QUERY_URL + SUPABASE_ACCESS_TOKEN to test Postgres;
// without them it still checks the registry against expr.ts.

import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const capSrc = src("../src/lib/capabilities.ts");
// Slice the OPERATORS block entry by entry rather than brace-matching:
// a doc string may itself contain braces (count_matching documents
// "{ field } leaves"), which a naive /\{[^}]*\}/ would stop at.
const opsBlock = (/export const OPERATORS = \{([\s\S]*?)\n\} as const/.exec(capSrc) ?? [])[1] ?? "";
const starts = [...opsBlock.matchAll(/^ {2}"?([^\s":]+)"?:\s*\{/gm)];
const entries = starts.map((m, i) => ({
  name: m[1],
  body: opsBlock.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : undefined),
}));

const registry = entries.filter((e) => e.body.includes("arity:")).map((e) => e.name);

// Server-only operators live in Postgres alone; expr.ts is not expected
// to implement them, and validation forbids them in browser contexts.
const serverOnly = new Set(entries.filter((e) => e.body.includes("serverOnly: true")).map((e) => e.name));

if (registry.length === 0) {
  console.error("Could not read operators from capabilities.ts");
  process.exit(1);
}

// expr.ts implements each operator as a `case "op":` in its switch.
const exprSrc = src("../src/lib/expr.ts");
const inExpr = new Set([...exprSrc.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));

const missingInExpr = registry.filter((op) => !inExpr.has(op) && !serverOnly.has(op));

// describe.ts turns an expression back into the sentence the owner reads
// and approves. Its default branch joins args with the operator name, so
// a missing case does not crash — it prints gibberish
// ("appointment_date count_matching appointment_time"), which is why
// this fourth copy has to be checked too. Server-only operators still
// appear in rules people read, so none are exempt here.
const describeSrc = src("../src/lib/describe.ts");
const inDescribe = new Set([...describeSrc.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
const missingInDescribe = registry.filter((op) => !inDescribe.has(op));

let failed = false;
if (missingInExpr.length) {
  console.error("✗ Advertised but not implemented in src/lib/expr.ts:", missingInExpr.join(", "));
  failed = true;
} else {
  console.log(`✓ expr.ts implements all ${registry.length} advertised operators`);
}

if (missingInDescribe.length) {
  console.error("✗ Advertised but unreadable in src/lib/describe.ts:", missingInDescribe.join(", "));
  failed = true;
} else {
  console.log(`✓ describe.ts can phrase all ${registry.length} advertised operators`);
}

const url = process.env.SUPABASE_DB_QUERY_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;

if (!url || !token) {
  console.log("· Skipping the Postgres check (set SUPABASE_DB_QUERY_URL and SUPABASE_ACCESS_TOKEN)");
} else {
  // abo_eval returns null for an operator it does not know, so a probe
  // that comes back null means Postgres has never heard of it.
  const probeFor = (op) => {
    const n = { op, args: [] };
    const arity = { today: 0, now: 0 }[op];
    if (arity !== 0) {
      n.args = op === "changed" || op === "count_matching" ? [{ field: "a" }] : [{ const: 1 }, { const: 1 }];
    }
    return n;
  };

  const selects = registry
    .map(
      (op, i) =>
        `public.abo_eval('${JSON.stringify(probeFor(op))}'::jsonb, '{"a":1}'::jsonb, '{}'::jsonb, '{}'::jsonb) as op${i}`
    )
    .join(", ");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `select ${selects}` }),
  });
  const body = await res.json();
  if (!Array.isArray(body)) {
    console.error("✗ Postgres probe failed:", JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }

  const row = body[0];
  const missingInPg = registry.filter((_, i) => row[`op${i}`] === null);
  if (missingInPg.length) {
    console.error("✗ Advertised but not implemented in Postgres:", missingInPg.join(", "));
    failed = true;
  } else {
    console.log(`✓ Postgres implements all ${registry.length} advertised operators`);
  }
}

process.exit(failed ? 1 : 0);
