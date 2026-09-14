// The MCP endpoint, checked as a client would drive it.
//
// Two things matter here and neither is visible from the code alone:
// that the handshake is right, so a real client can connect at all, and
// that a signed-in caller only ever reaches their own store.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-mcp.mjs
//   APP_URL=https://warmluke.vercel.app OWNER_PASSWORD=… node ...

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
const MCP = `${APP}/api/mcp`;

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const stamp = Date.now();
const email = `mcp_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const { data: sess } = await client.auth.signInWithPassword({ email, password });
const strangerToken = sess.session.access_token;

let n = 0;
const rpc = (method, params, token) =>
  fetch(MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const toolText = (res) => {
  try {
    return JSON.parse(res.json.result.content[0].text);
  } catch {
    return null;
  }
};

console.log("nothing here works without signing in");
// A client that can initialize unauthenticated concludes the server is
// open and never offers OAuth at all. Claude did exactly that.
for (const m of ["initialize", "tools/list", "ping"]) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: {} }),
  });
  check(`${m} is refused with 401`, r.status === 401);
  check(
    `${m} points at the resource metadata`,
    /resource_metadata="https?:\/\//.test(r.headers.get("www-authenticate") ?? "")
  );
}

console.log("\nthe handshake a client does before anything else");
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "check", version: "0" },
}, strangerToken);
check("initialize answers", init.status === 200 && !!init.json?.result);
check("it names a protocol version", !!init.json?.result?.protocolVersion);
check("it declares tools", !!init.json?.result?.capabilities?.tools);
check("it names itself", init.json?.result?.serverInfo?.name === "warmluke");

const list = await rpc("tools/list", {}, strangerToken);
const names = (list.json?.result?.tools ?? []).map((t) => t.name);
check("tools/list answers a signed-in caller", list.status === 200);
check(
  "all three tools are offered",
  ["store_overview", "search_orders", "propose_change"].every((t) => names.includes(t))
);
check(
  "every tool has a schema a model can fill in",
  (list.json?.result?.tools ?? []).every((t) => t.inputSchema?.type === "object" && t.description)
);

console.log("\nthings a client will send that are not requests");
const notif = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${strangerToken}` },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
check("a notification is accepted with 202 and no body", notif.status === 202);
check("GET is refused with 405, not a broken stream", (await fetch(MCP)).status === 405);

// The one that cost a real connection: Claude sends a revision newer
// than anything this server was written against, and a hardcoded list
// of "supported" versions turned that into a 400 before it could say
// hello. A newer revision has to be welcome.
const ping = (v) =>
  fetch(MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": v,
      Authorization: `Bearer ${strangerToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
check("a newer protocol revision still connects", (await ping("2026-06-18")).status === 200);
check("so does one from before", (await ping("2024-11-05")).status === 200);
check("something that is not a version is refused", (await ping("banana")).status === 400);

const negotiated = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "check", version: "0" },
}, strangerToken);
check(
  "a known revision is echoed back, not overridden",
  negotiated.json?.result?.protocolVersion === "2025-06-18"
);

const badOrigin = await fetch(MCP, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: "https://evil.example",
    Authorization: `Bearer ${strangerToken}`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
check("a request from another origin is refused", badOrigin.status === 403);

const unknown = await rpc("does/not/exist", {}, strangerToken);
check("an unknown method is a JSON-RPC error, not a crash", unknown.json?.error?.code === -32601);

const challenge = (
  await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  })
).headers.get("www-authenticate") ?? "";

console.log("\nthe discovery a client reads after that 401");
const metaUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
const meta = await fetch(metaUrl).then((r) => r.json());
check("it names this endpoint as the resource", meta.resource === MCP);
check("and names an authorization server", Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0);
// Clients differ on whether they append the resource path.
const withPath = await fetch(`${APP}/.well-known/oauth-protected-resource/api/mcp`);
check("the path-suffixed form resolves too", withPath.status === 200);

const asUrl = `${meta.authorization_servers[0]}/.well-known/oauth-authorization-server`;
const as = await fetch(asUrl).then((r) => r.json()).catch(() => null);
check("the authorization server is really there", !!as?.authorization_endpoint);
// Without dynamic registration a client cannot connect at all: nobody
// is going to hand ChatGPT a client id by hand.
check("and accepts clients registering themselves", !!as?.registration_endpoint);

try {
  console.log("\na stranger cannot ask for work on someone else's app");
  check(
    "propose_change is refused",
    !!toolText(
      await rpc(
        "tools/call",
        { name: "propose_change", arguments: { request: "delete everything" } },
        strangerToken
      )
    )?.error
  );

  console.log("\nsomeone else's store is not reachable");
  // The whole security model in one check: a signed-in stranger with a
  // valid token sees nothing, because RLS decides — not this route.
  const theirs = await rpc("tools/call", { name: "store_overview", arguments: {} }, strangerToken);
  check(
    "a signed-in stranger is told there is no store",
    /no shopify store/i.test(toolText(theirs)?.error ?? "")
  );
  const theirOrders = await rpc(
    "tools/call",
    { name: "search_orders", arguments: { limit: 100 } },
    strangerToken
  );
  check(
    "and cannot search orders either",
    /no shopify store/i.test(toolText(theirOrders)?.error ?? "")
  );

  console.log("\nthe owner's own store");
  const { data: owner } = await client.auth.signInWithPassword({
    email: "aaa@gmail.com",
    password: process.env.OWNER_PASSWORD ?? "",
  });
  if (!owner?.session) {
    console.log("  ..    no OWNER_PASSWORD given, the store checks did not run");
  } else {
    const t = owner.session.access_token;
    const over = toolText(await rpc("tools/call", { name: "store_overview", arguments: {} }, t));
    check("the overview names the shop", !!over?.shop_domain);
    check("and counts real rows", (over?.counts?.orders ?? 0) > 0);

    const all = toolText(await rpc("tools/call", { name: "search_orders", arguments: {} }, t));
    check("orders come back", (all?.count ?? 0) > 0);
    check("with the store's own currency, not the caller's", all?.currency === over?.currency);

    const cancelled = toolText(
      await rpc("tools/call", { name: "search_orders", arguments: { status: "cancelled" } }, t)
    );
    check("cancelled can be asked for", (cancelled?.orders ?? []).every((o) => !!o.cancelled_at));

    // A malformed day silently ignored would answer about every order
    // ever placed, which is the worst kind of wrong: plausible.
    const bad = toolText(
      await rpc("tools/call", { name: "search_orders", arguments: { day: "14/09/2026" } }, t)
    );
    check("a malformed day is refused, not ignored", /is not a date/.test(bad?.error ?? ""));

    const capped = toolText(
      await rpc("tools/call", { name: "search_orders", arguments: { limit: 100000 } }, t)
    );
    check("an absurd limit is capped", (capped?.count ?? 0) <= 100);

    console.log("\nasking for something to be built");
    // The point of the whole design: a request is recorded, and
    // nothing is built. A tool that quietly created a section would
    // put the merchant's approval card on the wrong side of the fence.
    const before = await admin.from("modules").select("*", { count: "exact", head: true });
    const proposed = toolText(
      await rpc(
        "tools/call",
        {
          name: "propose_change",
          arguments: { request: "Orders keep getting packed wrong, sort that out" },
        },
        t
      )
    );
    check("the request is recorded", !!proposed?.request_id);
    check("and it says nothing has changed yet", /nothing has changed/i.test(proposed?.note ?? ""));
    check("with somewhere for the merchant to go", /\/app\//.test(proposed?.open ?? ""));
    const after = await admin.from("modules").select("*", { count: "exact", head: true });
    check("no section was created", after.count === before.count);

    check(
      "an empty request is refused",
      /say what/i.test(
        toolText(
          await rpc("tools/call", { name: "propose_change", arguments: { request: "   " } }, t)
        )?.error ?? ""
      )
    );

    // A request nobody looks at is the same as no request, so the one
    // just made is cleared rather than left for the owner.
    await admin.from("build_requests").delete().eq("id", proposed.request_id);

    const noSuchShop = toolText(
      await rpc(
        "tools/call",
        { name: "store_overview", arguments: { shop_domain: "nope.myshopify.com" } },
        t
      )
    );
    check("an unknown shop is named, with what is available", Array.isArray(noSuchShop?.available));
  }
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest user removed");
}

console.log(fails.length === 0 ? "\nthe MCP server is honest" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
