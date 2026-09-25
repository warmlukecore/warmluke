// What "yesterday" means, and what a search actually returns.
//
// The day maths needs no account and runs first. The searches read the
// live database — they only read, never write — and are skipped with a
// loud line rather than silently when no store is connected.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-read.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { dayRangeInZone, readStoreRows, searchOrders, storeOverview, storeValues } from "../src/lib/store-read.ts";
import { realStores } from "./owner-session.mjs";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("a day belongs to the store, not the server");
// India is +5:30, so its day starts the previous evening in UTC. A
// server asking for "orders on the 14th" in UTC would miss the first
// five and a half hours of them.
const ind = dayRangeInZone("2026-09-14", "Asia/Kolkata");
check("Kolkata's day starts at 18:30 the evening before", ind.from === "2026-09-13T18:30:00.000Z");
check("and ends 24 hours later", ind.to === "2026-09-14T18:30:00.000Z");

// The seeded store is in New York: four hours behind in summer, five in
// winter. That difference is a whole evening of orders.
const summer = dayRangeInZone("2026-09-14", "America/New_York");
check("New York in September starts at 04:00 UTC", summer.from === "2026-09-14T04:00:00.000Z");
const winter = dayRangeInZone("2026-01-14", "America/New_York");
check("New York in January starts at 05:00 UTC", winter.from === "2026-01-14T05:00:00.000Z");

// The day the clocks go forward is 23 hours long. Treating every day as
// 86,400,000ms files an hour of that day's orders under the wrong day.
const spring = dayRangeInZone("2026-03-08", "America/New_York");
check(
  "the spring-forward day is 23 hours, not 24",
  Date.parse(spring.to) - Date.parse(spring.from) === 23 * 3600 * 1000
);
const fall = dayRangeInZone("2026-11-01", "America/New_York");
check("the fall-back day is 25 hours", Date.parse(fall.to) - Date.parse(fall.from) === 25 * 3600 * 1000);

check("UTC is left alone", dayRangeInZone("2026-09-14", "UTC").from === "2026-09-14T00:00:00.000Z");
check(
  "a malformed date is refused, not guessed",
  (() => {
    try {
      dayRangeInZone("14/09/2026", "UTC");
      return false;
    } catch {
      return true;
    }
  })()
);

// ── Against the real store ──────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const stores = await realStores(db, "id, project_id, shop_domain, timezone, currency, last_synced_at");
if (stores.length === 0) {
  console.log("\nno connected store — the search checks did not run");
} else {
  const store = stores[0];
  console.log(`\nreading ${store.shop_domain}`);

  const over = await storeOverview(db, store.id);
  check("the overview found the store", over?.shop_domain === store.shop_domain);
  check("it counts orders", (over?.counts.orders ?? 0) > 0);
  check("it counts products", (over?.counts.products ?? 0) > 0);
  check(
    "an unknown store id returns nothing, not an empty shell",
    (await storeOverview(db, "00000000-0000-0000-0000-000000000000")) === null
  );

  const all = await searchOrders(db, store, { limit: 100 });
  check("a plain search returns orders", all.length > 0);
  check(
    "each one carries its money",
    all.every((o) => typeof o.total === "number")
  );
  check(
    "newest first",
    all.every((o, i) => i === 0 || (all[i - 1].placed_at ?? "") >= (o.placed_at ?? ""))
  );

  const cancelled = await searchOrders(db, store, { status: "cancelled" });
  check(
    "cancelled can be asked for on its own",
    cancelled.every((o) => !!o.cancelled_at)
  );
  check("and it is not every order", cancelled.length < all.length);

  // The trap: a cancelled order keeps its old financial status, so a
  // status search that ignores cancellation hands back orders that are
  // not really in that state.
  const paid = await searchOrders(db, store, { status: "paid" });
  check(
    "a status search excludes cancelled orders",
    paid.every((o) => !o.cancelled_at)
  );

  check("the limit is honoured", (await searchOrders(db, store, { limit: 1 })).length <= 1);
  check("an absurd limit is capped, not obeyed", (await searchOrders(db, store, { limit: 100000 })).length <= 100);

  const withPeople = all.filter((o) => o.customer);
  check("orders carry their customer", withPeople.length > 0);

  const phone = withPeople[0]?.customer?.phone;
  if (phone) {
    check("searching a phone finds that person's orders", (await searchOrders(db, store, { q: phone })).length > 0);
  }

  const number = all[0]?.order_number;
  if (number) {
    const byNumber = await searchOrders(db, store, { q: number });
    check(
      "searching an order number finds it",
      byNumber.some((o) => o.order_number === number)
    );
  }

  check(
    "a term nobody matches returns nothing, not everything",
    (await searchOrders(db, store, { q: "zzz-no-such-thing" })).length === 0
  );

  const placed = all.find((o) => o.placed_at);
  if (placed) {
    // Asked as the store's own calendar day, which is the whole point.
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: store.timezone }).format(new Date(placed.placed_at));
    const sameDay = await searchOrders(db, store, { day });
    check(
      `an order placed on ${day} is found by that day in ${store.timezone}`,
      sameDay.some((o) => o.order_number === placed.order_number)
    );
  }
  console.log("\nwhat the assistant is told a column contains");
  {
    // The bug this exists for: the assistant wrote filter options out
    // of its head — "active" for a store whose products say "ACTIVE" —
    // and every choice matched nothing. Counts told it how much there
    // was and never what it said.
    const values = await storeValues(db, store.id);
    const status = values["products.status"] ?? [];
    check("product statuses come back", status.length > 0);
    check(
      "spelled the way the rows spell them",
      status.every((v) => v === v.toUpperCase())
    );

    const rows = (await readStoreRows(db, store.id, "products", 500)).rows;
    const real = new Set(rows.map((r) => String(r.data.status ?? "").trim()).filter(Boolean));
    check(
      "and every one of them is really in the rows",
      status.every((v) => real.has(v))
    );
    check(
      "nothing that is in the rows is left out",
      [...real].every((v) => status.includes(v))
    );

    // The field a merchant means by "category". Before it was
    // imported, a category filter could not be built at all.
    const category = values["products.product_type"] ?? [];
    check("categories come back", category.length > 0);
    check(
      "as a column somebody can see",
      rows.some((r) => String(r.data.product_type ?? "").trim() !== "")
    );

    // A blank is not a category, and a dropdown offering one helps
    // nobody.
    check(
      "blanks are never offered",
      Object.values(values).every((list) => list.every((v) => v.trim() !== ""))
    );
  }
}

console.log(fails.length === 0 ? "\nthe read layer is honest" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
