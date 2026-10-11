// GoSwift, stood in for (lib/connectors/goswift, 0205).
//
// No network: fetch answers as GoSwift's published API (v3.8.8) does.
// Holds the login (proved once, by client ID; a refusal said as one),
// a delivery to our address mapped to its order, courier and status
// (delivered, gone back, not delivered and why), our address registered
// once and kept, made again when GoSwift no longer has it as ours, the
// quiet shipments asked after, the token renewed near its end and once
// more when turned away, and a 429 as "later".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-goswift.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import { fromHook, fromTrack, login, sync } from "../src/lib/connectors/goswift.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = (n = 86400) => json(200, { access_token: "T1", scope: "core:all", expires_in: n, token_type: "Bearer" });

console.log("\nthe login");
{
  const asked = [];
  const ok = await login({ client_id: " 64f0c1 ", username: "api@shop.in", password: "pw" }, async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(init.body) });
    return token();
  });
  check(
    "is proved once, against its client ID",
    asked.length === 1 && asked[0].url === "https://app.goswift.in/integrations/v2/auth/token/64f0c1"
  );
  check("with the API login", asked[0].body.username === "api@shop.in" && asked[0].body.password === "pw");
  const kept = JSON.parse(ok.secret);
  check(
    "and keeps it with its token and when it lapses",
    kept.token === "T1" && Date.parse(kept.token_until) > Date.now() + 23 * 3600_000 && kept.client_id === "64f0c1"
  );
  check("named by the account, shown by the login", ok.accountRef === "64f0c1" && ok.accountLabel === "api@shop.in");
  let refused = null;
  try {
    await login({ client_id: "x", username: "u", password: "bad" }, async () =>
      json(401, { statusCode: 401, code: "UNAUTHORIZED", message: "Invalid credentials", severity: "error" })
    );
  } catch (e) {
    refused = e;
  }
  check(
    "a wrong one is a refusal, in GoSwift's words",
    refused instanceof ConnectorRefused && /Invalid/.test(refused.message)
  );
  let empty = null;
  try {
    await login({ client_id: "", username: "u", password: "p" }, async () => token());
  } catch (e) {
    empty = e;
  }
  check("and one with a field missing never leaves", empty instanceof ConnectorRefused);
}

console.log("\na delivery to our address");
{
  // GoSwift's own examples, from its webhook documentation.
  const [made] = fromHook({
    id: "509271DS0153341",
    wbn: "3496549343",
    vendor: "BLUEDART",
    orderNumber: "RAZNE009",
    channelId: "66111e20da60dcb528a11cad",
  });
  check("a shipment made names its order", made.order_ref === "RAZNE009" && made.shipment_ref === "509271DS0153341");
  check("and its AWB and courier", made.awb === "3496549343" && made.courier === "BLUEDART");
  check("and says no status it was not told", made.status === null && made.rto === false && made.ndr_reason === null);
  check("with a way to track it", made.track_url === "https://app.goswift.in/track/509271DS0153341");
  const [done] = fromHook({
    ctime: 1657523187604,
    status: "Delivered",
    location: "",
    desc: "Delivered Successfully",
    attempts: "0",
    pickupTime: 1655980197000,
    wbn: "318019134877",
    id: "501346BN6838925",
    orderNumber: "41839",
    edd: 1657523187609,
  });
  check("a delivered one says when", done.status === "Delivered" && done.delivered_at === "2022-07-11T07:06:27.604Z");
  check("and when it was picked up", done.shipped_at === "2022-06-23T10:29:57.000Z");
  const [back] = fromHook({ id: "S2", status: "RTO In Transit", ctime: 1657523187604 });
  check("one going back is marked RTO", back.rto === true && back.delivered_at === null);
  const [missed] = fromHook({ id: "S3", status: "Undelivered", desc: "Customer Unavailable", attempts: "2" });
  check(
    "one not delivered says why, and how often",
    missed.ndr_reason === "Customer Unavailable" && missed.ndr_attempts === 2
  );
  check(
    "and a delivery that is no shipment is no row",
    fromHook({ cart: { items: [] } }).length === 0 && fromHook(null).length === 0
  );
}

console.log("\nthe tracking call");
{
  const row = fromTrack({
    _id: "501346BN6838925",
    order_number: "41839",
    track: { status: "Undelivered", ctime: 1657523187604, desc: "Attempted", ndrStatus: "Address Issue", attempts: 1 },
  });
  check(
    "reads its status and the NDR GoSwift names",
    row.status === "Undelivered" && row.ndr_reason === "Address Issue"
  );
  check("and leaves the AWB it does not carry", row.awb === null && row.order_ref === "41839");
  check("and an answer with no shipment is none", fromTrack({}) === null);
}

const BASE = "https://www.warmluke.com/api/connectors/goswift/hook/";
/** Everything a sync did, in order, on both sides. */
const log = [];
const fresh = (extra = {}) =>
  JSON.stringify({
    client_id: "64f0c1",
    username: "api@shop.in",
    password: "pw",
    token: "T1",
    token_until: new Date(Date.now() + 20 * 3600_000).toISOString(),
    ...extra,
  });
const io = ({ quiet = [], deadline = Date.now() + 60_000 } = {}) => {
  const seen = { rows: [], cursors: [], secrets: [], hooks: [], asked: [] };
  return {
    seen,
    io: {
      deadline,
      hookBase: BASE,
      putShipments: async (rows) => void seen.rows.push(...rows),
      putCursor: async (r, c, t) => void seen.cursors.push({ r, c, t }),
      putSecret: async (s) => void seen.secrets.push(JSON.parse(s)),
      putHook: async (t) => {
        log.push("put hook");
        seen.hooks.push(t);
      },
      openShipments: async (settled, limit) => {
        seen.asked.push({ settled, limit });
        return quiet;
      },
    },
  };
};
/** GoSwift, holding the webhooks it was given. */
const goswift = (hooks = [], extra = () => null) => {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: u.pathname,
      auth: init.headers?.Authorization,
      body: init.body && JSON.parse(init.body),
    });
    log.push(`${method} ${u.pathname}`);
    const other = await extra(u, method, init);
    if (other) return other;
    if (u.pathname.startsWith("/integrations/v2/auth/token/"))
      return json(200, { access_token: "T2", expires_in: 86400 });
    if (u.pathname === "/api/v2/webhook" && method === "GET") return json(200, hooks);
    if (u.pathname === "/api/v2/webhook" && method === "POST") {
      const made = { id: "wh_1", ...JSON.parse(init.body) };
      hooks.push(made);
      return json(200, made);
    }
    if (u.pathname.startsWith("/api/v2/webhook/") && method === "PUT")
      return json(200, { id: u.pathname.split("/").pop(), ...JSON.parse(init.body) });
    if (u.pathname.startsWith("/api/v1/track/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      if (id === "GONE") return json(404, { message: "Not found" });
      return json(200, { _id: id, track: { status: "Delivered", ctime: 1657523187604, desc: "Delivered" } });
    }
    return json(404, {});
  };
  return { f, calls, hooks };
};

console.log("\na first sync");
{
  const { seen, io: it } = io();
  const gs = goswift();
  const done = await sync({ secret: fresh(), cursors: {} }, it, gs.f);
  const posted = gs.calls.find((c) => c.method === "POST" && c.path === "/api/v2/webhook");
  check("registers our address with GoSwift", !!posted && posted.auth === "Bearer T1");
  check(
    "for shipments made, made again, and every tracking step",
    ["track_updated", "shipment_created", "shipment_recreated"].every((t) => posted.body.topics.includes(t))
  );
  const kept = seen.secrets.at(-1)?.hook;
  check(
    "at an address with a token of its own",
    posted.body.url === BASE + kept?.token && /^[0-9a-f]{64}$/.test(kept.token)
  );
  check("signed with a secret GoSwift takes", posted.body.secret.length >= 8 && posted.body.secret.length <= 30);
  check(
    "the address accepted before GoSwift is told it",
    seen.hooks[0] === kept.token && log.indexOf("put hook") < log.indexOf("POST /api/v2/webhook")
  );
  check("and keeps which webhook is ours", kept.id === "wh_1");
  check("coming back in half an hour", done.nextMinutes === 30 && seen.cursors.at(-1)?.r === "tracking");
}

console.log("\nthe next");
{
  const hook = { id: "wh_1", token: "a".repeat(64), secret: "s".repeat(30) };
  const live = [
    {
      id: "wh_1",
      url: BASE + hook.token,
      active: true,
      topics: ["track_updated", "shipment_created", "shipment_recreated"],
    },
  ];
  const { seen, io: it } = io({ quiet: ["Q1", "GONE"] });
  const gs = goswift(live);
  await sync({ secret: fresh({ hook }), cursors: {} }, it, gs.f);
  check("leaves an address that is listening", !gs.calls.some((c) => c.method !== "GET") && seen.hooks.length === 0);
  check("and the token it has", seen.secrets.length === 0);
  check(
    "asks after the quiet ones, never the settled",
    seen.asked[0]?.settled.includes("Delivered") && seen.asked[0].settled.includes("RTO Delivered")
  );
  const q1 = seen.rows.find((r) => r.shipment_ref === "Q1");
  check("and writes what tracking says", q1?.status === "Delivered" && !!q1.delivered_at);
  const gone = seen.rows.find((r) => r.shipment_ref === "GONE");
  check(
    "one it cannot tell about is marked asked, and nothing else",
    gone && gone.status === undefined && gone.awb === null
  );
  check(
    "tracking without our token: it is open",
    gs.calls.filter((c) => c.path.startsWith("/api/v1/track/")).every((c) => !c.auth)
  );
}
{
  const hook = { id: "wh_1", token: "a".repeat(64), secret: "s".repeat(30) };
  const { seen, io: it } = io();
  const gs = goswift([{ id: "wh_1", url: "https://elsewhere.example/hook", active: false, topics: ["track_updated"] }]);
  await sync({ secret: fresh({ hook }), cursors: {} }, it, gs.f);
  const put = gs.calls.find((c) => c.method === "PUT");
  check("an address GoSwift no longer has as ours is made again, in place", put?.path === "/api/v2/webhook/wh_1");
  check(
    "with a new token, accepted first",
    put.body.url === BASE + seen.hooks[0] && seen.secrets.at(-1).hook.token === seen.hooks[0]
  );
}
{
  const hook = { id: "wh_gone", token: "a".repeat(64), secret: "s".repeat(30) };
  const { io: it } = io();
  const gs = goswift([]);
  await sync({ secret: fresh({ hook }), cursors: {} }, it, gs.f);
  check(
    "and one GoSwift lost is registered anew",
    gs.calls.some((c) => c.method === "POST" && c.path === "/api/v2/webhook")
  );
}

console.log("\nthe token");
{
  const { seen, io: it } = io();
  const gs = goswift();
  await sync(
    { secret: fresh({ token_until: new Date(Date.now() + 5 * 60_000).toISOString() }), cursors: {} },
    it,
    gs.f
  );
  check("near its end, it is renewed first", seen.secrets[0]?.token === "T2" && gs.calls[1]?.auth === "Bearer T2");
}
{
  const { seen, io: it } = io();
  let first = true;
  const gs = goswift([], (u, method) => {
    if (u.pathname === "/api/v2/webhook" && method === "GET" && first) {
      first = false;
      return json(401, { message: "Token expired" });
    }
    return null;
  });
  await sync({ secret: fresh(), cursors: {} }, it, gs.f);
  check(
    "one GoSwift turns away is renewed once, and the sync goes on",
    seen.secrets[0]?.token === "T2" && seen.hooks.length === 1
  );
}
{
  const { io: it } = io();
  let refused = null;
  try {
    await sync({ secret: fresh(), cursors: {} }, it, async (url) =>
      String(url).includes("/auth/token/") ? json(401, { message: "Inactive client" }) : json(401, {})
    );
  } catch (e) {
    refused = e;
  }
  check("a login it no longer takes is a refusal", refused instanceof ConnectorRefused);
}
{
  const { io: it } = io();
  let busy = null;
  try {
    await sync({ secret: fresh(), cursors: {} }, it, async () => json(429, {}));
  } catch (e) {
    busy = e;
  }
  check("asked to wait, it waits", busy instanceof ConnectorBusy);
}

console.log(fails.length === 0 ? "\ngoswift, as it answers" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
