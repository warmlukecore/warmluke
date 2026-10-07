// What Luke noticed, in words (lib/alerts.ts), against what the
// database watches for (0163).
//
// The database names each kind and its settings; the app says them. A
// setting renamed on one side would leave a number with no words, or a
// field the database refuses; a kind with no words shows plainly and
// cannot be asked of Luke. Every sentence is read with facts as the
// database writes them, and with none: never "undefined" or "NaN".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-alert-words.mjs

import { readFileSync, readdirSync } from "node:fs";
import { ALERT_WORDS, describeAlert, wordsOf } from "../src/lib/alerts.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The kinds as the newest migration that seeds them leaves them.
const dir = new URL("../supabase/migrations/", import.meta.url);
const seeded = new Map();
for (const f of readdirSync(dir).sort()) {
  const sql = readFileSync(new URL(f, dir), "utf8");
  for (const m of sql.matchAll(
    /\('([a-z_]+)', '[^']+', '\{[a-z_,]*\}', 'abo_alert_[a-z_]+',\s*'(\{[^']*\})', \d+\)/g
  )) {
    seeded.set(m[1], Object.keys(JSON.parse(m[2])));
  }
}

const SAMPLE = {
  low_stock: {
    product: "Linen shirt",
    variant: "M",
    sku: "LIN-M",
    available: 3,
    per_day: 1,
    days_left: 3,
    sales_days: 14,
  },
  dispatch_late: { count: 2, hours: 48, oldest_hours: 70, orders: ["#1008", "#1011"] },
  returns_spike: { product: "Linen shirt", this_week: 4, per_week: 0.5 },
  return_reason: { reason: "Too small", count: 3, days: 14, products: ["Linen shirt"], notes: ["Runs a size small"] },
};

console.log("every kind the database watches for has its words");
check("the migrations seed the four kinds", seeded.size >= 4);
for (const [kind, keys] of seeded) {
  const w = ALERT_WORDS[kind];
  check(`${kind}: has words`, !!w);
  if (!w) continue;
  check(
    `${kind}: its settings are the database's, each said`,
    JSON.stringify(w.settings.map((s) => s.key).sort()) === JSON.stringify([...keys].sort())
  );
  check(`${kind}: can be asked of Luke`, typeof w.ask === "function");
}

console.log("\nevery sentence reads, with the facts and without them");
const broken = (t) => /undefined|NaN|null|\[object/.test(t ?? "");
for (const kind of seeded.keys()) {
  const full = describeAlert({ kind, facts: SAMPLE[kind] ?? {} });
  const bare = describeAlert({ kind, facts: {} });
  check(
    `${kind}: with its facts`,
    !broken(full.title) && !broken(full.detail) && !broken(full.ask) && full.title.length > 0
  );
  check(`${kind}: with none`, !broken(bare.title) && !broken(bare.detail) && !broken(bare.ask));
}
check(
  "the shirt says what it is and how long it lasts",
  describeAlert({ kind: "low_stock", facts: SAMPLE.low_stock }).title === "Linen shirt · M runs out in about 3 days"
);
check(
  "an empty shelf says so",
  describeAlert({ kind: "low_stock", facts: { ...SAMPLE.low_stock, available: 0, days_left: 0 } }).title ===
    "Linen shirt · M is out of stock"
);
check(
  "hours past two days are said in days",
  describeAlert({ kind: "dispatch_late", facts: SAMPLE.dispatch_late }).title === "2 orders not sent after 2 days"
);
check(
  "Luke is told the numbers",
  describeAlert({ kind: "low_stock", facts: SAMPLE.low_stock }).ask.includes(
    "has 3 left to sell, selling about 1 a day"
  )
);
// Said as the title says it (7 Oct): "has 0 left … runs out in about 0 days" under "is out of stock".
const out = describeAlert({ kind: "low_stock", facts: { ...SAMPLE.low_stock, available: 0, days_left: 0 } });
check(
  "an item already out is asked about as out, with no days to run",
  out.ask.includes("has none left to sell") && !/runs out|0 days/.test(out.ask)
);
check(
  "one that runs out today is asked about as today, not in fractions of a day",
  describeAlert({ kind: "low_stock", facts: { ...SAMPLE.low_stock, days_left: 0.75 } }).ask.includes(
    "so it runs out today"
  )
);
check(
  "a slow seller says what sold, not a pace it does not have",
  /with about 1 sold in the last 14 days/.test(
    describeAlert({ kind: "low_stock", facts: { ...SAMPLE.low_stock, per_day: 0.1, sales_days: 14 } }).ask
  )
);

console.log("\na kind the app does not know yet still shows");
const unknown = describeAlert({ kind: "conversion_drop", facts: { rate: 1.2 } });
check(
  "named from its kind",
  unknown.title === "Conversion drop" && wordsOf("conversion_drop").name === "Conversion drop"
);
check("with no question for Luke", unknown.ask === null);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nevery alert says what it is, in words");
process.exit(fails.length ? 1 : 0);
