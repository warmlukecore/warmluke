// Shiprocket, stood in for (lib/connectors/shiprocket, 0204).
//
// No network: fetch answers as Shiprocket's own published examples do.
// Holds the login (proved once, a refusal said as one), the dates as it
// writes them, a shipment mapped to its Shopify order and money, the
// pages walked and a long walk handed on, the token renewed before it
// lapses and once more when it is turned away, and a 429 as "later".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-shiprocket.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import { login, shiprocketDate, shipmentsOf, sync } from "../src/lib/connectors/shiprocket.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// An order as Shiprocket's "Get all Orders" example writes one.
const order = (n, extra = {}) => ({
  id: 16178800 + n,
  channel_order_id: String(1000 + n),
  status: "DELIVERED",
  payment_method: n % 2 ? "cod" : "prepaid",
  total: "899.00",
  created_at: "31 Jul 2026, 03:03 PM",
  shipments: [{ id: 16028500 + n, courier: "Delhivery", awb: `AWB${n}` }],
  ...extra,
});

console.log("\nthe login");
{
  const asked = [];
  const ok = await login({ email: " API@Shop.in ", password: "pw" }, async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(init.body) });
    return json(200, { token: "T1", email: "api@shop.in" });
  });
  check("is proved once, against the login", asked.length === 1 && asked[0].url.endsWith("/auth/login"));
  check("with the email as Shiprocket keeps it", asked[0].body.email === "api@shop.in");
  const kept = JSON.parse(ok.secret);
  check(
    "and keeps the login with its token and when it came",
    kept.token === "T1" && !!kept.token_at && kept.password === "pw"
  );
  check("named by the API user", ok.accountRef === "api@shop.in");
  let refused = null;
  try {
    await login({ email: "x@y.in", password: "bad" }, async () =>
      json(400, { message: "These credentials do not match our records.", status_code: 400 })
    );
  } catch (e) {
    refused = e;
  }
  check(
    "a wrong one is a refusal, in Shiprocket's words",
    refused instanceof ConnectorRefused && /do not match/.test(refused.message)
  );
}

console.log("\nthe dates as it writes them, in India's time");
check("31 Jul 2019, 03:03 PM", shiprocketDate("31 Jul 2019, 03:03 PM") === "2019-07-31T09:33:00.000Z");
check("28th Aug 2018 07:11 PM", shiprocketDate("28th Aug 2018 07:11 PM") === "2018-08-28T13:41:00.000Z");
check("2019-08-01 05:20:55", shiprocketDate("2019-08-01 05:20:55") === "2019-07-31T23:50:55.000Z");
check("and nothing it cannot read", shiprocketDate("someday") === null && shiprocketDate("") === null);

console.log("\na shipment");
{
  const [row] = shipmentsOf(order(1));
  check("names its Shopify order", row.order_ref === "1001");
  check("and its AWB and courier", row.awb === "AWB1" && row.courier === "Delhivery");
  check("COD carries what is to be collected", row.payment_mode === "cod" && row.cod_amount === 899);
  check("prepaid carries none", shipmentsOf(order(2))[0].cod_amount === null);
  check("with a way to track it", row.track_url === "https://app.shiprocket.in/tracking/awb/AWB1");
  check("and one with no shipment yet is no row", shipmentsOf(order(3, { shipments: [] })).length === 0);
}

const fresh = JSON.stringify({ email: "api@shop.in", password: "pw", token: "T1", token_at: new Date().toISOString() });
const io = (deadline = Date.now() + 60_000) => {
  const seen = { rows: [], cursors: [], secrets: [] };
  return {
    seen,
    io: {
      deadline,
      putShipments: async (rows) => void seen.rows.push(...rows),
      putCursor: async (r, c, t) => void seen.cursors.push({ r, c, t }),
      putSecret: async (s) => void seen.secrets.push(JSON.parse(s)),
    },
  };
};
const pages = (n) => async (url) => {
  const page = Number(new URL(String(url)).searchParams.get("page"));
  return json(200, {
    data: [order(page * 10), order(page * 10 + 1)],
    meta: { pagination: { total_pages: n, current_page: page } },
  });
};

console.log("\na sync");
{
  const { seen, io: it } = io();
  const done = await sync({ secret: fresh, cursors: {} }, it, pages(3));
  check("walks every page", seen.rows.length === 6);
  check("and says it is up to date", seen.cursors.at(-1)?.c === null && !!seen.cursors.at(-1)?.t);
  check("coming back in half an hour", done.nextMinutes === 30);
  check("with the token it had", seen.secrets.length === 0);
}
{
  const { seen, io: it } = io(Date.now() - 1);
  const done = await sync({ secret: fresh, cursors: { orders: { cursor: "2", synced_through: null } } }, it, pages(3));
  check("out of time, it keeps its place for the next run", seen.cursors[0]?.c === "2" && done.nextMinutes === 5);
}
{
  const { seen, io: it } = io();
  const stale = JSON.stringify({
    email: "api@shop.in",
    password: "pw",
    token: "OLD",
    token_at: "2026-01-01T00:00:00Z",
  });
  const bearer = [];
  await sync({ secret: stale, cursors: {} }, it, async (url, init) => {
    if (String(url).endsWith("/auth/login")) return json(200, { token: "NEW" });
    bearer.push(init.headers.Authorization);
    return pages(1)(url);
  });
  check("a token near its 240 hours is renewed first", seen.secrets[0]?.token === "NEW" && bearer[0] === "Bearer NEW");
}
{
  const { seen, io: it } = io();
  let first = true;
  await sync({ secret: fresh, cursors: {} }, it, async (url) => {
    if (String(url).endsWith("/auth/login")) return json(200, { token: "T2" });
    if (first) {
      first = false;
      return json(401, { message: "Token expired" });
    }
    return pages(1)(url);
  });
  check(
    "one it turns away is renewed once, and the sync goes on",
    seen.secrets[0]?.token === "T2" && seen.rows.length === 2
  );
}
{
  const { io: it } = io();
  let refused = null;
  try {
    await sync({ secret: fresh, cursors: {} }, it, async (url) =>
      String(url).endsWith("/auth/login") ? json(400, { message: "Inactive user." }) : json(401, {})
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
    await sync({ secret: fresh, cursors: {} }, it, async () => json(429, {}));
  } catch (e) {
    busy = e;
  }
  check("asked to wait, it waits", busy instanceof ConnectorBusy);
}

console.log(fails.length === 0 ? "\nshiprocket, as it answers" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
