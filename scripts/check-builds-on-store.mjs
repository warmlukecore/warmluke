// Work on the store's rows is built on the store's rows.
//
// Asked to help pack orders, Luke built a second list of orders to fill
// in by hand, beside the real ones, because a section over the store
// could hold nothing of the merchant's. Now it can (0128), and this is
// the request that decides whether the design uses it: three pieces of
// everyday work, each done to a list the store already has. Each has to
// be designed as a section over that list, with a field of the
// merchant's beside each row, and without a hand-kept copy of it.
//
// Through the chat, as the panel sends it, each in a thread of its own.
// Recorded against real models by hand and played back everywhere else
// (model-tape.ts): the server and this process both need the same mode.
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-builds-on-store.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";
import { retypedCopies } from "../src/lib/describe.ts";
import { ownColumns } from "../src/lib/store-read.ts";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1, and this writes; nothing checked`);
  process.exit(0);
}
const APP = process.env.APP_URL ?? "http://localhost:3100";
process.env.MODEL_TAPE ??= "replay";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 400));

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "builds on store");

/** One chat turn, in a thread of its own, and what it ended with. */
async function ask(message) {
  const res = await fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${me.session.access_token}` },
    body: JSON.stringify({ message, projectId: project.id, conversationId: null }),
  });
  const serverTape = res.headers.get("x-model-tape");
  if (res.ok && serverTape !== process.env.MODEL_TAPE) {
    throw new Error(
      `the server at ${APP} is ${serverTape ? `in ${serverTape} mode` : "making real model calls"}, and this check is in ${process.env.MODEL_TAPE} mode; start it with MODEL_TAPE=${process.env.MODEL_TAPE}`
    );
  }
  const lines = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return lines.filter((l) => !("step" in l) && !("words" in l)).at(-1) ?? {};
}

const WORK = [
  {
    about: "scanning and packing orders",
    lists: ["orders"],
    message:
      "Before the courier comes we pack every order. I want to scan each order's number with my barcode scanner, have it marked packed, and see which orders are still left to pack. Design it now, no questions.",
  },
  {
    about: "restocking what runs low",
    lists: ["inventory_levels", "variants", "products"],
    message:
      "When stock runs low I order more from the supplier. I want to mark a low item as reordered, with the date I ordered it, and see which low ones still need ordering. Design it now, no questions.",
  },
  {
    about: "following up customers",
    lists: ["customers"],
    message:
      "I want to follow up customers who have not ordered in a while: note when I called each one and what they said, and see who I have not called yet. Design it now, no questions.",
  },
];

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `builds-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);

  for (const w of WORK) {
    console.log(`\n${w.about}`);
    const out = await ask(w.message);
    const reply = out.reply;
    const plans = reply?.type === "blueprint" ? reply.blueprint.plans : reply?.type === "plans" ? reply.plans : [];
    check("is designed", plans.length > 0);
    if (!plans.length) show(out);
    const over = plans.find((p) => p.changeType === "NEW_MODULE" && w.lists.includes(p.newModule?.source_table ?? ""));
    check(`as a section over the store's ${w.lists.join(" or ")}`, !!over);
    const mine = over ? ownColumns(over.newModule.source_table, over.newSchema?.columns ?? []) : [];
    check(
      "with a field of theirs beside each row",
      mine.some((c) => !c.compute)
    );
    if (over) show({ section: over.newModule.nav_label, theirs: mine.map((c) => `${c.field}:${c.type}`) });
    const copies = retypedCopies(plans, { shop_domain: "", currency: "INR", counts: {} });
    check("and no second list of it typed in by hand", copies.length === 0);
    if (copies.length) show(copies);
  }
} finally {
  await project.remove();
}

console.log(
  fails.length === 0 ? "\nwork on the store's rows is built on the store's rows" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
