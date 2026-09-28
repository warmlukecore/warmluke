// What reads as a code, and so gets a copy button (lib/no-ids).
//
// Decided from the value, never from a field's name: a SKU of any
// shape, an AWB, an order number, a coupon — one token with a digit
// in it. A name, a word, a date, an internal id: not.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-code-values.mjs

import { looksLikeCode } from "../src/lib/no-ids.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("codes, of any shape the merchant uses");
for (const v of ["CF-0055-1", "#1304", "1001", "AWB1234567890", "WELCOME10", "SKU_7/A", "  bt-0042 "])
  check(`"${v.trim()}" is a code`, looksLikeCode(v));

console.log("\nnot codes");
for (const v of ["Arjun King", "Paid", "COD", "2026-09-28", "2026-09-28T10:00", "ab", "", null, 1304, "x".repeat(41)])
  check(`${JSON.stringify(v)} is not`, !looksLikeCode(v));
check("an internal id is not", !looksLikeCode("a2b00467-45d4-4f0f-b04d-094867745b14"));

console.log(fails.length === 0 ? "\nwhat reads as a code is copied, and nothing else" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
