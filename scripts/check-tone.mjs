// What a badge says, and in what colour.
//
// A store's statuses mean something — PENDING is a payment not yet in —
// and a merchant's own words mean whatever they meant by them. The two
// must never be confused: "Pending" in a repairs section is not a
// payment, and drawing it as one tells the merchant something false.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-tone.mjs

import { badgeClasses, badgeLabel, knownStatus, quietClasses, TONE_CLASSES } from "../src/lib/tone.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("a store's statuses, in the store's own words");
check(
  "PENDING is a payment waiting",
  badgeLabel("PENDING") === "Payment pending" && knownStatus("PENDING")?.tone === "attention"
);
check("PAID needs nothing", knownStatus("PAID")?.tone === "neutral");
check("UNFULFILLED is still to send", knownStatus("UNFULFILLED")?.progress === "incomplete");
check("PARTIALLY_FULFILLED is half way", knownStatus("PARTIALLY_FULFILLED")?.progress === "partial");
check("with space around it, still the store's", badgeLabel(" PAID ") === "Paid");
check("a product's status reads as words", badgeLabel("ACTIVE") === "Active" && badgeLabel("ARCHIVED") === "Archived");

console.log("\na merchant's own words stay theirs");
check(
  "'Pending' in their section is not a payment",
  knownStatus("Pending") === null && badgeLabel("Pending") === "Pending"
);
check("nor 'pending', nor 'In progress'", knownStatus("pending") === null && knownStatus("In progress") === null);
check("'Paid' written by hand is their word too", knownStatus("Paid") === null);
check("and never drawn in a tone that means attention", !Object.values(TONE_CLASSES).includes(badgeClasses("Pending")));
check("the same word is always the same colour", badgeClasses("Pending") === quietClasses("Pending"));
check("an empty value is quiet grey", badgeClasses("") === TONE_CLASSES.neutral);
check(
  "a status Shopify might add later is its own word, calmly",
  knownStatus("ON_ICE") === null && badgeLabel("ON_ICE") === "ON_ICE"
);

console.log(fails.length === 0 ? "\na badge says only what it means" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
