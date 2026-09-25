// A build is one thing, or it is nothing.
//
// Plans are applied one at a time, each in its own transaction, because
// that is all PostgREST offers. So a design whose second plan fails used
// to leave the first one standing: a section with no rule in it, sitting
// in the merchant's sidebar under the name of the thing they approved,
// with nothing anywhere saying half of it never happened.
//
// This drives the real applyPlans against an in-memory stand-in for the
// database — no network, no credentials — makes the second plan fail,
// and checks that the first one was taken back out.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-rollback.mjs

import { applyPlans } from "../src/lib/apply.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const PROJECT = "99999999-9999-9999-9999-999999999999";

/**
 * Enough of the Supabase client for the apply path: the one RPC it
 * writes through, and the handful of tables it reads back.
 *
 * `failOn` is the op that refuses, which is how a mid-build failure is
 * staged without needing one to happen for real.
 */
function stubDb({ failOn }) {
  const tables = { modules: [], ui_schemas: [], records: [], automations: [], stores: [] };
  const ops = [];
  let seq = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;

  const rpc = async (_fn, { p_op, p_payload }) => {
    ops.push({ op: p_op, payload: p_payload });
    if (p_op === failOn) return { data: null, error: { message: `refused: ${p_op}` } };
    switch (p_op) {
      case "module_insert": {
        const id = uuid();
        tables.modules.push({
          id,
          project_id: PROJECT,
          parent_id: null,
          ...p_payload,
          sort_order: p_payload.sort_order ?? 0,
        });
        return { data: { id }, error: null };
      }
      case "module_delete": {
        const before = tables.modules.length;
        tables.modules = tables.modules.filter((m) => m.id !== p_payload.module_id);
        return { data: { count: before - tables.modules.length }, error: null };
      }
      case "schema_insert": {
        const id = uuid();
        tables.ui_schemas.push({ id, ...p_payload });
        return { data: { id }, error: null };
      }
      case "records_insert":
        for (const r of p_payload.rows ?? []) {
          tables.records.push({ module_id: p_payload.module_id, data: r });
        }
        return { data: { count: (p_payload.rows ?? []).length }, error: null };
      case "automation_insert": {
        const id = uuid();
        tables.automations.push({ id, ...p_payload });
        return { data: { id }, error: null };
      }
      case "automation_delete": {
        const before = tables.automations.length;
        tables.automations = tables.automations.filter(
          (a) => !(a.module_id === p_payload.module_id && a.name === p_payload.name)
        );
        return { data: { count: before - tables.automations.length }, error: null };
      }
      default:
        return { data: {}, error: null };
    }
  };

  // The query builder is chainable and only ever filters on equality
  // and orders by one column, which is all the apply path asks of it.
  const from = (name) => {
    let rows = () => tables[name] ?? [];
    const q = {
      select: () => q,
      eq(col, val) {
        const prev = rows;
        rows = () => prev().filter((r) => r[col] === val);
        return q;
      },
      order(col, { ascending }) {
        const prev = rows;
        rows = () => [...prev()].sort((a, b) => ((a[col] ?? 0) - (b[col] ?? 0)) * (ascending ? 1 : -1));
        return q;
      },
      limit(n) {
        const prev = rows;
        rows = () => prev().slice(0, n);
        return q;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve) => resolve({ data: rows(), error: null }),
    };
    return q;
  };

  return { client: { rpc, from }, tables, ops };
}

const plans = [
  {
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: {
      name: "low-stock",
      nav_label: "Low stock",
      icon: "package",
      parent_id: null,
      source_table: null,
    },
    newSchema: {
      columns: [
        { field: "product", label: "Product", type: "text" },
        { field: "stage", label: "Stage", type: "badge" },
      ],
    },
    newRecords: null,
    explanation: "A place to watch stock running out.",
  },
  {
    changeType: "AUTOMATION_ADD",
    targetModuleId: "#low-stock",
    automation: {
      name: "Flag it",
      definition: {
        trigger: { type: "record_updated" },
        actions: [{ type: "set_fields", target: { self: true }, set: { stage: { const: "Low" } } }],
      },
    },
    explanation: "Marks the row when stock is low.",
  },
];

console.log("both plans succeed");
{
  const { client, tables } = stubDb({ failOn: null });
  const out = await applyPlans(client, PROJECT, structuredClone(plans));
  check("no errors", out.errors.length === 0);
  if (out.errors.length) console.log(`     errors were: ${out.errors.join(" | ")}`);
  check("both are reported applied", out.applied.length === 2);
  check("the section is there", tables.modules.length === 1);
  check("and so is the rule", tables.automations.length === 1);
}

console.log("\nthe second plan is refused");
{
  const { client, tables, ops } = stubDb({ failOn: "automation_insert" });
  const out = await applyPlans(client, PROJECT, structuredClone(plans));

  check("it is reported as an error", out.errors.length > 0);
  // The whole point: the first plan had already been written, and the
  // old code left it standing and reported it as applied.
  check("nothing is reported as applied", out.applied.length === 0);
  check(
    "and the owner is told the app is as it was",
    out.errors.some((e) => /Nothing was built/.test(e))
  );
  check("the section that was created is gone", tables.modules.length === 0);
  check(
    "the undo actually ran",
    ops.some((o) => o.op === "module_delete")
  );
  // Reversed, so a section's contents come out before the section —
  // this must not depend on which foreign keys happen to cascade.
  const deleteAt = ops.findIndex((o) => o.op === "module_delete");
  const insertAt = ops.findIndex((o) => o.op === "module_insert");
  check("and it ran after the write it reverses", deleteAt > insertAt);
  if (fails.length) console.log(`     ops were: ${ops.map((o) => o.op).join(" -> ")}`);
}

console.log("\nthe same build, this time with seeded rows");
{
  // RECORD_SEED has no opposite — there is no records_delete op — so
  // the run has to stay readable rather than throw on the way out.
  const { client } = stubDb({ failOn: "automation_insert" });
  const seeded = [{ ...plans[0], newRecords: [{ product: "A cable", stage: "Low" }] }, plans[1]];
  const out = await applyPlans(client, PROJECT, structuredClone(seeded));
  check("still reports nothing built", out.applied.length === 0);
  check(
    "with a readable reason",
    out.errors.some((e) => /Nothing was built/.test(e))
  );
}

console.log(fails.length === 0 ? "\na build is one thing or none" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
