// Moving between a merchant's stores, and adding another.
//
// Each store is its own project, and the switcher is how a merchant
// with several gets from one to the next. What it says about a store
// has to be what the dashboard says — the same function decides both —
// and moving between two must not carry anything from one into the
// other. "Connect another store" makes a project only once Shopify has
// named the store, so turning back at Shopify leaves nothing empty.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-switcher.mjs

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { accessRanOut, storeStanding } from "../src/lib/store-standing.ts";
import { entryTarget, isConnectHint, NEW_PROJECT } from "../src/lib/shopify-entry.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = Date.parse("2026-09-23T12:00:00Z");
const hourAgo = new Date(NOW - 36e5).toISOString();
const inAMonth = new Date(NOW + 30 * 864e5).toISOString();
const lastWeek = new Date(NOW - 7 * 864e5).toISOString();

console.log("how a store stands, said once");
const at = (s) => storeStanding(s, NOW);
check("working: connected", at({ status: "connected" }).tone === "ok" && !at({ status: "connected" }).reconnect);
check("an hour-old access token is not a problem", at({ status: "connected", token_expires_at: hourAgo, refresh_token_expires_at: inAMonth }).tone === "ok");
check("a store from before expiring tokens works forever", !accessRanOut({ status: "connected" }, NOW));
check("a refresh token that ran out needs a reconnect",
  at({ status: "connected", token_expires_at: hourAgo, refresh_token_expires_at: lastWeek }).reconnect === true);
check("so does an expiring token with no refresh date", accessRanOut({ status: "connected", token_expires_at: hourAgo }, NOW));
check("importing says so", at({ status: "connected", importing: true }).tone === "busy");
check("but an import never hides a dead token",
  at({ status: "connected", importing: true, token_expires_at: hourAgo, refresh_token_expires_at: lastWeek }).tone === "warn");
check("removed from Shopify needs a reconnect", at({ status: "uninstalled" }).reconnect && /Removed/.test(at({ status: "uninstalled" }).label));
check("one that never came back needs a reconnect", at({ status: "pending" }).reconnect);
check("a status nobody has seen before is not called working", at({ status: "something-new" }).tone === "warn");

console.log("\nand the switcher and the dashboard read it from the same place");
const switcher = src("src/components/StoreSwitcher.tsx");
const dashboard = src("src/app/dashboard/page.tsx");
check("the switcher decides with storeStanding", /storeStanding\(/.test(switcher));
check("the dashboard's reconnect line uses the same accessRanOut", /accessRanOut\(store\)/.test(dashboard));
check("and neither keeps a copy of the refresh-date rule", !/refresh_token_expires_at\) </.test(dashboard + switcher));
check("an attempt that never came back is not offered as a store", /status === "pending" && !s\.connected_at/.test(switcher));
check("a list that failed to load is not shown as no stores", /if \(error\) return;/.test(switcher));
check("the list is read again each time it opens", /if \(!open\) return;\s*load\(\);/.test(switcher));
check("it writes nothing", !/\.(insert|update|delete|upsert)\(/.test(switcher));

console.log("\nmoving between stores carries nothing across");
check("the app shell is mounted fresh for each project",
  /<AppShell key=\{projectId\} projectId=\{projectId\}/.test(src("src/app/app/[projectId]/page.tsx")));
check("the switcher sits at the foot of the sidebar", /<StoreSwitcher projectId=\{projectId\} placement="sidebar" \/>/.test(src("src/components/AppShell.tsx")));

console.log("\nconnect another store: a project only once Shopify names the store");
check("the hint for it is its own word", NEW_PROJECT === "new" && isConnectHint("new"));
check("a project id is a hint too", isConnectHint("11111111-2222-3333-4444-555555555555"));
check("anything else is not", !isConnectHint("New") && !isConnectHint("new ") && !isConnectHint("../x") && !isConnectHint(null));
{
  const SECRET = "check-secret";
  const q = { shop: "second-store.myshopify.com", timestamp: String(Math.floor(Date.now() / 1000)), host: "x" };
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&");
  const signed = { ...q, hmac: createHmac("sha256", SECRET).update(msg).digest("hex") };
  const r = entryTarget({ query: signed, secret: SECRET, origin: "https://w.example", project: "new" });
  check("Shopify's return carries it to the connect page", new URL(r.to).searchParams.get("project") === "new");
}
check("the one-tap start accepts it", /isConnectHint\(project\)/.test(src("src/app/api/shopify/start/route.ts")));
const connect = src("src/app/connect/page.tsx");
check("the connect page makes the project only after Shopify named the store",
  /else if \(wantsNew\) \{\s*started\.current = true;\s*newProject\(\);/.test(connect) && /if \(started\.current \|\| !shop \|\| projects === null \|\| already\) return;/.test(connect));
check("and a store already connected is shown, not connected twice", /if \(already\) \{/.test(connect));
check("the switcher's add goes through one tap when there is one, else the dashboard",
  /oneTap \? "\/api\/shopify\/start\?project=new" : "\/dashboard"/.test(switcher));

console.log(fails.length === 0 ? "\nevery store is one tap from the others" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
