// The ceiling on /api/mcp, and the record it leaves.
//
// A client in a loop is the failure this guards against, and it is not
// a failure anyone notices until the bill arrives — so the limit has
// to be checked rather than assumed. Reaching it through the endpoint
// would mean three hundred real requests, so the rows are put in
// directly and the function is asked what it thinks.
//
// Everything happens under a throwaway user, removed at the end.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-mcp-limit.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const stamp = Date.now();
const email = `lim_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
const user = createClient(URL_, ANON);
await user.auth.signInWithPassword({ email, password });

try {
  console.log("an ordinary run");
  const first = (await user.rpc("abo_mcp_call", { p_tool: "search_store" })).data;
  check("the call is allowed", first?.ok === true);
  check("and counted", first?.used === 1);
  const second = (await user.rpc("abo_mcp_call", { p_tool: "low_stock" })).data;
  check("the next one counts up", second?.used === 2);

  const { data: rows } = await user.from("mcp_calls").select("tool").order("id");
  check("both were recorded", rows?.length === 2);
  check("with the tool that was called", rows?.[1]?.tool === "low_stock");

  console.log("\nthe record is a record");
  const forged = await user.from("mcp_calls").insert({ user_id: made.user.id, tool: "never happened" });
  check("a caller cannot add to it", !!forged.error);
  const wiped = await user.from("mcp_calls").delete().eq("user_id", made.user.id).select();
  check("nor erase it", !wiped.data?.length);

  console.log("\nand at the ceiling");
  // The last hour, filled in as the loop would fill it.
  const filler = Array.from({ length: 300 }, () => ({
    user_id: made.user.id,
    tool: "search_orders",
  }));
  await admin.from("mcp_calls").insert(filler);

  const over = (await user.rpc("abo_mcp_call", { p_tool: "search_store" })).data;
  check("the call is refused", over?.ok === false);
  check("and says what the limit is", over?.limit === 300);
  const after = await admin.from("mcp_calls").select("*", { count: "exact", head: true }).eq("user_id", made.user.id);
  // A refusal that still writes a row would keep the account locked
  // out for an hour longer every time it retried.
  check("a refusal writes nothing", after.count === 302);

  console.log("\nand an hour later");
  await admin
    .from("mcp_calls")
    .update({ created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() })
    .eq("user_id", made.user.id);
  const later = (await user.rpc("abo_mcp_call", { p_tool: "search_store" })).data;
  check("the window has moved on", later?.ok === true);
  check("and the count starts again", later?.used === 1);
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest user removed");
}

console.log(fails.length === 0 ? "\nthe ceiling holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
