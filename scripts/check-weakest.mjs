// Which gate fires most.
//
// The repair count tells you something went wrong; it never tells you
// what. Guessing at that is how a day goes into the wrong fix — a
// malformed shape and a design that missed the point both show up as
// "repairs: 2" and want opposite remedies.
//
// Every validator message is stored on the assistant's message row, so
// this is a read, not a new pipeline. The top line is the prompt's
// weakest point, measured. When its count falls, the fix worked.
//
//   node scripts/check-weakest.mjs        # all time
//   node scripts/check-weakest.mjs 7      # last 7 days

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const days = Number(process.argv[2] ?? 0);
const since = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : null;

const r = await fetch(
  `${env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL}/rest/v1/messages` +
    `?select=payload,created_at&role=eq.assistant` +
    (since ? `&created_at=gte.${since}` : ""),
  {
    headers: {
      apikey: env.ADAPTIVE_OS_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.ADAPTIVE_OS_SERVICE_ROLE_KEY}`,
    },
  }
);
const rows = await r.json();
if (!Array.isArray(rows)) {
  console.error(rows);
  process.exit(1);
}

// Messages carry the owner's own field and section names, so the same
// fault reads as a hundred different strings. Strip the quoted parts to
// see the fault itself.
const shape = (msg) => msg.replace(/"[^"]*"/g, "X").replace(/\s+/g, " ").trim();

const counts = new Map();
let withRepairs = 0;
for (const row of rows) {
  const errs = row.payload?.repairErrors;
  if (!Array.isArray(errs) || errs.length === 0) continue;
  withRepairs++;
  for (const e of errs) counts.set(shape(e), (counts.get(shape(e)) ?? 0) + 1);
}

const total = rows.length;
console.log(
  `${total} assistant replies${since ? ` in the last ${days} days` : ""}, ` +
    `${withRepairs} needed a repair (${total ? Math.round((withRepairs / total) * 100) : 0}%)\n`
);

if (counts.size === 0) {
  console.log("No repairs recorded yet — run the app or the scenario suite first.");
  process.exit(0);
}

const ranked = [...counts].sort((a, b) => b[1] - a[1]);
const width = String(ranked[0][1]).length;
for (const [msg, n] of ranked.slice(0, 15)) {
  console.log(`${String(n).padStart(width)}×  ${msg.slice(0, 110)}`);
}
console.log("\nThe top line is where the prompt is weakest. Fix that, then run this again.");
