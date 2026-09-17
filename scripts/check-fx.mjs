// Turning a shop's money into the merchant's money.
//
// A shop selling in USD inside a project set to INR has to show one of
// two things: the real number in dollars, or a converted number that
// says it was converted. The third option — the dollar number wearing a
// rupee sign — is the one that must never happen, because it is the
// only one that looks completely correct while being wrong by a factor
// of ninety-six.
//
// So this checks the arithmetic, and it checks the boundary: a rate
// decides what every imported amount reads as, and this deployment
// keeps no service-role key, so the server writes with exactly the
// rights a browser has. If anyone could write a rate for anyone, one
// merchant could make every other merchant's orders wrong.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-fx.mjs

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { makeFormatting } from "../src/lib/money.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The check that would have caught this shipping dead.
//
// The arithmetic passed, the route answered curl, and the feature did
// nothing in production — the effect that calls it had been lost to a
// bad edit, so every mismatch fell into the "no rate" branch and the
// page looked exactly as it had before. A check that only tests the
// parts cannot notice that nothing joins them.
console.log("the feature is actually wired up");
{
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  check("something asks for a rate", /apiFetch\(`\/api\/fx/.test(shell));
  check("and something does so with the answer", /setFx\(/.test(shell));
  check("only when the two currencies differ", /from === to/.test(shell));
  // Written against what has to be true, not against how it is
  // currently spelled: the rate must reach a converter somewhere. The
  // first version matched the exact JSX and broke the moment the two
  // call sites were given one shared decision.
  check("and the rate reaches a converter", /convert:\s*\{\s*rate:\s*fx\.rate/.test(shell));
  check(
    "which both the section and the chat preview use",
    (shell.match(/convert=\{sectionMoney\.convert\}/g) ?? []).length >= 2
  );

  // A client-only module imported from a server one compiles in tsc
  // and fails in next build, and the error says neither "Failed" nor
  // "error TS" — which is how it was missed.
  const fmt = readFileSync(new URL("../src/lib/format.tsx", import.meta.url), "utf8");
  const money = readFileSync(new URL("../src/lib/money.ts", import.meta.url), "utf8");
  check("the file with React in it says so", fmt.startsWith('"use client"'));
  check("and the file without React does not", !money.includes('"use client"'));
}

console.log("\nthe arithmetic");
{
  const plain = makeFormatting("en-IN", "INR");
  const converted = makeFormatting("en-IN", "INR", { rate: 95.96, from: "USD" });

  check("without a rate, the number is untouched", plain.money(100).includes("100"));
  // 100 dollars is about 9,596 rupees. The failure being guarded
  // against is it reading as ₹100.
  check("with one, the amount is actually converted", /9,596/.test(converted.money(100)));
  check("and it is labelled in the merchant's currency", converted.money(100).includes("₹"));
  check(
    "a rate of one changes nothing",
    makeFormatting("en-IN", "INR", { rate: 1, from: "USD" }).money(100) === plain.money(100)
  );
  // 100.05 x 95.96 is 9,600.798. Rounding the amount BEFORE converting
  // would give 9,596 — the same-looking answer that is four rupees out
  // on one row and unbounded over a page of them.
  check(
    "fractions are converted, not rounded first",
    /9,600\.80/.test(makeFormatting("en-IN", "INR", { rate: 95.96, from: "USD" }).money(100.05))
  );
}

const anon = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const { data: owner } = await anon.auth.signInWithPassword({
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("\nno OWNER_PASSWORD given — the rest is not checked");
  process.exit(fails.length === 0 ? 0 : 1);
}

const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const { data: project } = await admin.from("projects").select("id").limit(1).single();
const ask = (q) =>
  fetch(`${APP}/api/fx?${q}`, {
    headers: { Authorization: `Bearer ${owner.session.access_token}` },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

console.log("\nasking for a rate");
{
  const got = await ask(`from=USD&to=INR&project=${project.id}`);
  check("a real pair comes back", got.status === 200 && typeof got.body?.rate === "number");
  check("with a sensible number", got.body?.rate > 0 && got.body?.rate < 100000);
  // Without this the app cannot say how old the number is, and an
  // unlabelled conversion is the thing being avoided.
  check("and the day it is from", typeof got.body?.as_of === "string");

  const same = await ask(`from=INR&to=INR&project=${project.id}`);
  check("the same currency is not a conversion", same.body?.rate === 1 && same.body?.same === true);

  const junk = await ask(`from=%27%3Bdrop&to=INR&project=${project.id}`);
  check("a made-up code is refused", junk.status === 400);

  const nowhere = await ask(`from=USD&to=ZZZ&project=${project.id}`);
  check("a code nobody trades is refused, not invented", nowhere.status === 503);

  const noProject = await ask("from=USD&to=INR");
  check("and it will not answer without a project", noProject.status === 400);
}

console.log("\nand whose rate it is");
{
  const theirs = await ask("from=USD&to=INR&project=00000000-0000-0000-0000-000000000001");
  check("another project's rate is refused", theirs.status === 403);

  // The boundary that matters, because the function's own check is the
  // only thing standing between one merchant and everybody else's
  // numbers.
  const forged = await anon.rpc("abo_fx_put", {
    p_project: "00000000-0000-0000-0000-000000000001",
    p_base: "USD",
    p_quote: "INR",
    p_rate: 1,
    p_as_of: "2026-01-01",
  });
  check("and cannot be written by hand either", forged.error?.code === "42501");

  const silly = await anon.rpc("abo_fx_put", {
    p_project: project.id,
    p_base: "USD",
    p_quote: "INR",
    p_rate: -1,
    p_as_of: "2026-01-01",
  });
  check("a rate that is not a rate is refused", silly.error?.code === "22023");

  const table = await anon.from("fx_rates").insert({
    project_id: project.id,
    base: "USD",
    quote: "INR",
    rate: 1,
    as_of: "2026-01-01",
  });
  check("and the table itself is not writable", !!table.error);
}

console.log(fails.length === 0 ? "\nmoney means what it says" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
