// Onboarding: what it asks, where a person is in it, and who is sent.
//
// The form's lists and the table's are two copies of one thing, so
// they are compared here rather than trusted to agree. Where someone is
// in the flow is a function of what is true, so every path through it
// is walked. And the door into it — the dashboard — must never lock
// anybody out of their projects because a read failed.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-onboarding.mjs

import { readFileSync } from "node:fs";
import {
  HEARD_OPTIONS,
  ORDER_OPTIONS,
  PLATFORM_OPTIONS,
  RETURN_WITHIN_MS,
  ROLE_OPTIONS,
  TEAM_OPTIONS,
  currentStep,
  heardDetailPrompt,
  MEMBER_ROLE_OPTIONS,
  needsOnboarding,
  problems,
  returnsToOnboarding,
  toRow,
} from "../src/lib/onboarding.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

console.log("the form and the table hold the same lists");
const sql = src("supabase/migrations/0112_who_is_behind_each_account.sql");
const listIn = (column) => {
  const m = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`).exec(sql);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null;
};
for (const [column, options] of [
  ["role", ROLE_OPTIONS],
  ["monthly_orders", ORDER_OPTIONS],
  ["platform", PLATFORM_OPTIONS],
  ["team_size", TEAM_OPTIONS],
  ["heard_from", HEARD_OPTIONS],
]) {
  const table = listIn(column);
  const form = options.map((o) => o.value).sort();
  check(`${column}: ${form.length} choices, the same in both`, JSON.stringify(table) === JSON.stringify(form));
  check(
    `${column}: every choice has words to show`,
    options.every((o) => o.label.trim().length > 0)
  );
}

{
  // The one list asked of an invited person, held by the seat itself (0118).
  const seats = src("supabase/migrations/0118_who_joined_and_taking_an_account_off.sql");
  const m = /team_role in \(([^)]*)\)/.exec(seats);
  const table = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null;
  const form = MEMBER_ROLE_OPTIONS.map((o) => o.value).sort();
  check(`team_role: ${form.length} choices, the same in both`, JSON.stringify(table) === JSON.stringify(form));
}

console.log("\nwhat is asked for, and what can wait");
const good = {
  full_name: "  Asha Rao ",
  business_name: "Rao Ceramics",
  role: "founder",
  monthly_orders: "500_2000",
  platform: "shopify",
  website: "",
  team_size: "",
  heard_from: "",
  heard_from_detail: "",
};
check("a complete form has nothing wrong", Object.keys(problems(good)).length === 0);
const blank = problems({ ...good, full_name: " ", business_name: "", role: "", monthly_orders: "", platform: "" });
check(
  "each required answer missing is named",
  ["full_name", "business_name", "role", "monthly_orders", "platform"].every((k) => typeof blank[k] === "string")
);
check("and the optional ones are not", !blank.website && !blank.team_size && !blank.heard_from);
check(
  "a name longer than the table holds is refused first",
  !!problems({ ...good, full_name: "x".repeat(121) }).full_name
);
check("a choice that is not on the list is refused", !!problems({ ...good, role: "ceo" }).role);
check("an optional choice off the list is too", !!problems({ ...good, team_size: "a few" }).team_size);

console.log("\nwhat is saved");
const row = toRow({ ...good, website: "  rao.in ", heard_from: "twitter", heard_from_detail: "a thread" });
check("answers are trimmed", row.full_name === "Asha Rao" && row.website === "rao.in");
check(
  "an optional answer left empty is null, not an empty string",
  toRow(good).team_size === null && toRow(good).website === null
);
check("a follow-up only survives beside the answer that asked for it", row.heard_from_detail === null);
check(
  "and is kept when it belongs",
  toRow({ ...good, heard_from: "referral", heard_from_detail: " Meera " }).heard_from_detail === "Meera"
);
check(
  "only 'someone told me' and 'somewhere else' ask a follow-up",
  !!heardDetailPrompt("referral") && !!heardDetailPrompt("other") && !heardDetailPrompt("twitter")
);

console.log("\nwhere a person is");
const at = (o) =>
  currentStep({
    profile: false,
    storeConnected: false,
    storeSkipped: false,
    assistantOffered: true,
    assistantDone: false,
    importing: false,
    preparingSkipped: false,
    ...o,
  });
check("nothing saved yet: about them", at({}) === "about");
check("answers saved, no store: the store", at({ profile: true }) === "store");
check("the store left for later: their AI", at({ profile: true, storeSkipped: true }) === "assistant");
check(
  "their AI not offered to this account: straight on",
  at({ profile: true, storeSkipped: true, assistantOffered: false }) === "done"
);
check(
  "store connected, AI done, import running: preparing",
  at({ profile: true, storeConnected: true, assistantDone: true, importing: true }) === "preparing"
);
check(
  "and not waiting for it when they said so",
  at({ profile: true, storeConnected: true, assistantDone: true, importing: true, preparingSkipped: true }) === "done"
);
check(
  "no store means no import to wait on",
  at({ profile: true, storeSkipped: true, assistantDone: true, importing: true }) === "done"
);
check(
  "an answer saved is never asked again",
  at({ profile: true, storeConnected: true, assistantDone: true }) !== "about"
);

console.log("\nwho is sent to it");
check("a new account is", needsOnboarding({ onboarded: false, ownProjects: 0, sharedWithMe: 0 }));
check(
  "an account from before onboarding existed is too",
  needsOnboarding({ onboarded: false, ownProjects: 3, sharedWithMe: 0 })
);
check("somebody who finished is not", !needsOnboarding({ onboarded: true, ownProjects: 0, sharedWithMe: 0 }));
check(
  "a person only invited into someone else's app is not",
  !needsOnboarding({ onboarded: false, ownProjects: 0, sharedWithMe: 1 })
);
check(
  "but one with an app of their own as well is",
  needsOnboarding({ onboarded: false, ownProjects: 1, sharedWithMe: 2 })
);
check(
  "and Warmluke's own team is not, apps or no apps",
  !needsOnboarding({ onboarded: false, ownProjects: 3, sharedWithMe: 0, staff: true })
);

console.log("\ncoming back from Shopify");
const now = Date.parse("2026-09-23T12:00:00Z");
check("a note from a minute ago sends them back", returnsToOnboarding(String(now - 60e3), now));
check("one from yesterday does not", !returnsToOnboarding(String(now - 864e5), now));
check("one exactly an hour old does not", !returnsToOnboarding(String(now - RETURN_WITHIN_MS), now));
check(
  "nor one from the future, or not a time at all",
  !returnsToOnboarding(String(now + 60e3), now) && !returnsToOnboarding("yes", now) && !returnsToOnboarding(null, now)
);

const app = src("src/app/app/[projectId]/page.tsx");
check("the app only goes back when Shopify has just connected", /get\("shopify"\) !== "connected"\) return;/.test(app));
check("and uses the note once", /localStorage\.removeItem\(RETURN_KEY\)/.test(app));

console.log("\nthe door never locks anyone out");
const dash = src("src/app/dashboard/page.tsx");
check("the dashboard asks the same function", /needsOnboarding\(\{/.test(dash));
check("a read that failed opens the dashboard", /if \(error\) \{\s*setGate\("open"\);\s*return;\s*\}/.test(dash));
check("a landing-page prompt waits until they are through", /handoffStarted \|\| gate !== "open"\) return;/.test(dash));

console.log("\nand the table keeps its own promises");
check("a person reads only their own row", /profiles_own_read[\s\S]*?using \(user_id = auth\.uid\(\)\)/.test(sql));
check(
  "and writes only their own",
  /profiles_own_insert[\s\S]*?with check \(user_id = auth\.uid\(\)\)/.test(sql) &&
    /profiles_own_update[\s\S]*?with check \(user_id = auth\.uid\(\)\)/.test(sql)
);
check(
  "nothing a connected AI's token can write",
  ["insert", "update", "delete"].every((op) =>
    new RegExp(`profiles_oauth_no_${op}[\\s\\S]*?as restrictive for ${op}`).test(sql)
  )
);
check(
  "finishing is stamped by the database, and cannot be undone",
  /old\.onboarded_at is not null then\s*new\.onboarded_at := old\.onboarded_at;\s*elsif new\.onboarded_at is not null then\s*new\.onboarded_at := now\(\);/.test(
    sql
  )
);
check(
  "the accounts screen gets the answers from the function that checks who asks",
  /abo_is_superadmin\(\)[\s\S]*left join public\.profiles/.test(sql)
);

const page = src("src/app/onboarding/page.tsx");
check("the page saves through toRow, never the raw form", /upsert\(\{ user_id: userId, \.\.\.toRow\(a\) \}/.test(page));
check(
  "finished people are sent on, not asked again",
  /if \(row\?\.onboarded_at\) \{\s*router\.replace\("\/dashboard"\);/.test(page)
);

console.log(fails.length === 0 ? "\nonboarding asks once, and keeps what it is told" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
