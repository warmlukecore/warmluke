// A section pointed at the store must render real values.
//
// Types cannot catch this one: a flatten that names a field the schema
// does not list, or a select that forgets a column, produces blank
// cells and no error anywhere. So every column a store table declares
// is checked against the rows it actually returns.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-sections.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  STORE_TABLES,
  isStoreTable,
  readStoreRows,
  storeTableSchema,
} from "../src/lib/store-read.ts";
import { realStores } from "./owner-session.mjs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("only the store's lists are accepted");
// From the one declaration, so a list added there is covered here.
for (const t of Object.keys(STORE_TABLES)) {
  check(`${t} is one`, isStoreTable(t));
}
// The column names a table that then gets queried, so anything not on
// the list must never get through.
for (const t of ["records", "stores", "modules", "", null, undefined, 1, "orders; drop"]) {
  check(`${JSON.stringify(t)} is refused`, !isStoreTable(t));
}

console.log("\nthe schema and the rows are the same list");
for (const [table, spec] of Object.entries(STORE_TABLES)) {
  const schema = storeTableSchema(table);
  check(
    `${table} declares the columns it flattens`,
    schema.columns.length === spec.columns.length && schema.columns.length > 0
  );
}

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

const [store] = await realStores(db, "id, project_id, shop_domain, timezone, currency, last_synced_at");
if (!store) {
  console.log("\nno connected store — the row checks did not run");
} else {
  console.log(`\nreading ${store.shop_domain} as sections`);
  for (const [table, spec] of Object.entries(STORE_TABLES)) {
    const { rows, total } = await readStoreRows(db, store.id, table, 50);
    if (rows.length === 0) {
      console.log(`  ..    ${table} is empty, nothing to render`);
      continue;
    }
    check(`${table}: the count is the table's, not the page's`, total >= rows.length);
    check(`${table}: every row has an id to key on`, rows.every((r) => !!r.id));
    check(`${table}: and no two rows share one`, new Set(rows.map((r) => r.id)).size === rows.length);

    // The real trap. A column the schema promises but flatten never
    // sets renders as an empty cell in every row, for ever, silently.
    for (const col of spec.columns) {
      check(
        `${table}: "${col.field}" is set on at least one row`,
        rows.some((r) => r.data[col.field] !== undefined && r.data[col.field] !== null)
      );
    }
    // And the other way. This used to refuse any field no column shows,
    // but a list reads some on purpose: financial_status is what revenue
    // is summed by, order_id is what an order's items hang off, the ids
    // in `gives` are what a change is aimed with. It went unnoticed for
    // as long as the check database had no store to run it on. What a
    // column does promise is its currency, and money read without it is
    // a bare number.
    for (const col of spec.columns.filter((c) => c.currencyField)) {
      check(
        `${table}: "${col.field}" comes with its currency`,
        rows.some((r) => r.data[col.currencyField] !== undefined && r.data[col.currencyField] !== null)
      );
    }
  }

  const { rows: orders } = await readStoreRows(db, store.id, "orders", 50);
  if (orders.length) {
    check(
      "orders arrive newest first",
      orders.every(
        (o, i) => i === 0 || (orders[i - 1].data.placed_at ?? "") >= (o.data.placed_at ?? "")
      )
    );
    check(
      "a date renders as a day, not a timestamp",
      orders.every((o) => !o.data.placed_at || /^\d{4}-\d{2}-\d{2}$/.test(o.data.placed_at))
    );
    // A cancelled order keeps its old financial status, so showing that
    // column alone would label a cancelled order "paid".
    check(
      "a cancelled order says Cancelled, not its old payment status",
      orders.some((o) => o.data.status === "Cancelled")
    );
  }
}

console.log(
  fails.length === 0 ? "\nstore-backed sections render real rows" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
