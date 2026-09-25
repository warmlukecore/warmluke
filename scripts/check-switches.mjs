// Two switches, and what each one actually stops.
//
// A switch enforced by hidden UI is not a switch — the routes are the
// only place it counts, because a merchant with a token can call them
// directly. This flips each one for a real account and drives both
// endpoints, then puts the account back as it was.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-switches.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { OWNER_EMAIL } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const sql = (query) =>
  fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const { data: owner } = await client.auth.signInWithPassword({
  email: OWNER_EMAIL,
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("no OWNER_PASSWORD given — nothing to check");
  process.exit(0);
}
const token = owner.session.access_token;
const uid = owner.user.id;

const db = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${token}` } },
});
const { data: projects } = await db.from("projects").select("id").limit(1);
const projectId = projects?.[0]?.id;

const set = (chat, mcp) =>
  sql(`insert into public.account_settings (user_id, chat_enabled, mcp_enabled)
       values ('${uid}', ${chat}, ${mcp})
       on conflict (user_id) do update
         set chat_enabled = ${chat}, mcp_enabled = ${mcp};`);

const chat = () =>
  fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, message: "hello" }),
  });

const mcp = () =>
  fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

const before = await db.rpc("abo_my_settings");
const was = before.data?.[0] ?? { chat_enabled: true, mcp_enabled: true };

try {
  console.log("Warmluke's assistant off, their own AI on");
  await set(false, true);
  check("the chat route refuses", (await chat()).status === 403);
  check("their own AI still connects", (await mcp()).status === 200);
  // The point of splitting the setting: an account without our chat
  // is not an account without a builder.
  const stillBuilds = await fetch(`${APP}/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, plans: [] }),
  });
  check("and approving a design is not blocked by it", stillBuilds.status === 400);

  console.log("\ntheir own AI off, Warmluke's assistant on");
  await set(true, false);
  check("the MCP endpoint refuses", (await mcp()).status === 403);
  const said = await chat();
  check("the chat route does not", said.status !== 403);

  console.log("\nneither");
  await set(false, false);
  check("both refuse", (await chat()).status === 403 && (await mcp()).status === 403);

  console.log("\nboth");
  await set(true, true);
  check("both answer", (await mcp()).status === 200 && (await chat()).status !== 403);
} finally {
  // A check that leaves a real account switched off is worse than no
  // check: the next person to open the app sees a product that looks
  // broken. So the restore is verified, not assumed — this already
  // happened once.
  await set(was.chat_enabled, was.mcp_enabled);
  const after = (await db.rpc("abo_my_settings")).data?.[0];
  check(
    "the account is back as it was",
    after?.chat_enabled === was.chat_enabled && after?.mcp_enabled === was.mcp_enabled
  );
}

console.log(fails.length === 0 ? "\nthe switches switch" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
