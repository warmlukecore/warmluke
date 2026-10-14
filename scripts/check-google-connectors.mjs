// Google Ads and Google Analytics, stood in for (lib/connectors/google*, 0215).
//
// No network: fetch answers as Google's token endpoint, the Google Ads
// API (v25 search) and the GA4 Data and Admin APIs do. Holds the
// sign-ins (a refresh token traded; a service account's JWT signed with
// its own key and checked against it), Google Ads' cost in micros and
// its headers, months walked and pages followed, GA4's dates and paging,
// and Google's refusals and "slow down" said as the framework hears them.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-google-connectors.mjs
import { createVerify, generateKeyPairSync } from "node:crypto";
import { addDays, ConnectorBusy, ConnectorRefused, dayIn } from "../src/lib/connectors/kit.ts";
import { fromServiceKey, serviceKey } from "../src/lib/connectors/google.ts";
import * as ads from "../src/lib/connectors/google-ads.ts";
import * as ga from "../src/lib/connectors/google-analytics.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const caught = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const io = () => {
  const put = {};
  const cursors = [];
  return {
    put,
    cursors,
    io: {
      deadline: Date.now() + 60_000,
      put: async (list, rows) => (put[list] ??= []).push(...rows),
      putCursor: async (resource, cursor, through) => cursors.push({ resource, cursor, through }),
      putSecret: async () => {},
      putShipments: async () => {},
      hookBase: "https://x/",
      putHook: async () => {},
      openShipments: async () => [],
    },
  };
};
const isToken = (url) => String(url).includes("oauth2.googleapis.com");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const keyJson = JSON.stringify({
  type: "service_account",
  client_email: "wl@shop.iam.gserviceaccount.com",
  private_key: pem,
});

console.log("\na service account's sign-in");
{
  check("its key file is read whole", serviceKey(keyJson)?.client_email === "wl@shop.iam.gserviceaccount.com");
  check("and anything else is not a key", serviceKey("{}") === null && serviceKey("not json") === null);
  let form = null;
  const token = await fromServiceKey(serviceKey(keyJson), "scope-x", async (url, init) => {
    form = new URLSearchParams(init.body);
    return json(200, { access_token: "ya29.T", expires_in: 3599 });
  });
  const [head, claims, sig] = form.get("assertion").split(".");
  const c = JSON.parse(Buffer.from(claims, "base64url").toString());
  check("trades a JWT for an hour's token", token === "ya29.T" && form.get("grant_type").endsWith("jwt-bearer"));
  check(
    "the JWT names the account, the scope and Google's token address, for an hour",
    c.iss === "wl@shop.iam.gserviceaccount.com" &&
      c.scope === "scope-x" &&
      c.aud.endsWith("/token") &&
      c.exp - c.iat === 3600
  );
  check(
    "and is signed with the account's own key",
    createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, sig, "base64url")
  );
  const revoked = await caught(() =>
    fromServiceKey(serviceKey(keyJson), "s", async () =>
      json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." })
    )
  );
  check("a key Google no longer takes asks the owner again", revoked instanceof ConnectorRefused);
}

console.log("\nGoogle Ads");
{
  check(
    "an account id is its ten digits",
    ads.customerId("123-456-7890") === "1234567890" && ads.customerId("12345") === null
  );
  const row = ads.spendRow({
    campaign: { id: "987", name: " Brand " },
    segments: { date: "2026-10-12" },
    metrics: {
      costMicros: "1250400000",
      impressions: "48211",
      clicks: "903",
      conversions: 15.5,
      conversionsValue: 22485,
    },
    customer: { currencyCode: "INR" },
  });
  check("cost in micros becomes money", row.spend === 1250.4 && row.currency === "INR");
  check(
    "conversions and their value are kept as Google counts them",
    row.purchases === 15.5 && row.purchase_value === 22485
  );
  check("a row with no campaign or day is skipped", ads.spendRow({ segments: { date: "2026-10-12" } }) === null);

  const asked = [];
  const fields = {
    developer_token: "DEV",
    client_id: "cid",
    client_secret: "csec",
    refresh_token: "1//r",
    customer_id: "123-456-7890",
    login_customer_id: "111-222-3333",
  };
  const fetchAds = async (url, init) => {
    if (isToken(url)) return json(200, { access_token: "ya29.A" });
    asked.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return json(200, {
      results: [{ customer: { descriptiveName: "Shop Ads", currencyCode: "INR", timeZone: "Asia/Kolkata" } }],
    });
  };
  const ok = await ads.login(fields, fetchAds);
  check(
    "connecting proves the login on the account",
    asked[0].url === "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search"
  );
  check(
    "with the developer token and the manager account as Google asks",
    asked[0].headers["developer-token"] === "DEV" &&
      asked[0].headers["login-customer-id"] === "1112223333" &&
      asked[0].headers.Authorization === "Bearer ya29.A"
  );
  check(
    "named by the account",
    ok.accountLabel === "Shop Ads (123-456-7890)" && JSON.parse(ok.secret).timezone === "Asia/Kolkata"
  );
  const missing = await caught(() => ads.login({ ...fields, refresh_token: "" }, fetchAds));
  check("a missing refresh token is refused before any call", missing instanceof ConnectorRefused);

  const run = io();
  const queries = [];
  const today = dayIn(new Date(), "Asia/Kolkata");
  await ads.sync({ secret: ok.secret, cursors: {} }, run.io, async (url, init) => {
    if (isToken(url)) return json(200, { access_token: "ya29.A" });
    const body = JSON.parse(init.body);
    queries.push(body);
    const more = queries.length === 1 ? { nextPageToken: "P2" } : {};
    return json(200, {
      results: [{ campaign: { id: "1", name: "A" }, segments: { date: today }, metrics: { costMicros: "1000000" } }],
      ...more,
    });
  });
  check(
    "reads 90 days, a month at a time",
    queries[0].query.includes(`BETWEEN '${addDays(today, -90)}'`) && queries.filter((q) => !q.pageToken).length === 4
  );
  check("following a page to the next", queries[1].pageToken === "P2");
  check("into the ad spend list", run.put.ad_spend?.length === queries.length && run.put.ad_spend[0].spend === 1);
  check(
    "then where it got to is kept",
    run.cursors.at(-1)?.resource === "campaigns" && run.cursors.at(-1)?.through?.startsWith(today)
  );

  const denied = await caught(() =>
    ads.sync({ secret: ok.secret, cursors: {} }, io().io, async (url) =>
      isToken(url)
        ? json(200, { access_token: "t" })
        : json(403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } })
    )
  );
  check(
    "an account the login may not read asks the owner",
    denied instanceof ConnectorRefused && /developer token/.test(denied.message)
  );
  const busy = await caught(() =>
    ads.sync({ secret: ok.secret, cursors: {} }, io().io, async (url) =>
      isToken(url) ? json(200, { access_token: "t" }) : json(429, { error: { status: "RESOURCE_EXHAUSTED" } })
    )
  );
  check("and Google's quota is a wait", busy instanceof ConnectorBusy);
}

console.log("\nGoogle Analytics");
{
  check(
    "a property id is its digits",
    ga.propertyId("properties/123456789") === "123456789" && ga.propertyId("G-ABC123") === null
  );
  const row = ga.trafficRow(
    {
      dimensionValues: [{ value: "20261012" }, { value: "facebook" }, { value: "paid" }, { value: "diwali" }],
      metricValues: [{ value: "1200" }, { value: "950" }, { value: "18" }, { value: "26990.5" }],
    },
    "INR"
  );
  check(
    "a row is a day, where it came from and what it did",
    row.day === "2026-10-12" &&
      row.source === "facebook" &&
      row.campaign === "diwali" &&
      row.sessions === 1200 &&
      row.revenue === 26990.5
  );
  const missing = await caught(() =>
    ga.login({ property_id: "123456789", service_account: "{}" }, async () => json(200, {}))
  );
  check("a key that is not one is refused before any call", missing instanceof ConnectorRefused);
  const notAdded = await caught(() =>
    ga.login({ property_id: "123456789", service_account: keyJson }, async (url) =>
      isToken(url) ? json(200, { access_token: "t" }) : json(403, { error: { status: "PERMISSION_DENIED" } })
    )
  );
  check(
    "a property the account was not added to says whom to add",
    notAdded instanceof ConnectorRefused && notAdded.message.includes("wl@shop.iam.gserviceaccount.com")
  );
  const ok = await ga.login({ property_id: "123456789", service_account: keyJson }, async (url) =>
    isToken(url)
      ? json(200, { access_token: "t" })
      : json(200, { displayName: "Shop GA4", timeZone: "Asia/Kolkata", currencyCode: "INR" })
  );
  check(
    "named by the property",
    ok.accountLabel === "Shop GA4 (123456789)" && JSON.parse(ok.secret).currency === "INR"
  );

  const run = io();
  const asked = [];
  await ga.sync({ secret: ok.secret, cursors: {} }, run.io, async (url, init) => {
    if (isToken(url)) return json(200, { access_token: "t" });
    const body = JSON.parse(init.body);
    asked.push({ url: String(url), body });
    const rows = Array.from({ length: body.offset === "0" ? 2 : 1 }, (_, i) => ({
      dimensionValues: [{ value: "20261012" }, { value: `s${i}` }, { value: "m" }, { value: "c" }],
      metricValues: [{ value: "1" }, { value: "1" }, { value: "0" }, { value: "0" }],
    }));
    return json(200, { rows, rowCount: 10_001 });
  });
  check(
    "reads the property's report",
    asked[0].url === "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport"
  );
  check(
    "by day and where visits came from",
    asked[0].body.dimensions.map((d) => d.name).join() === "date,sessionSource,sessionMedium,sessionCampaignName"
  );
  check("page by page until every row is read", asked.length === 2 && asked[1].body.offset === "10000");
  check(
    "into web traffic, in the property's currency",
    run.put.web_traffic?.length === 3 && run.put.web_traffic[0].currency === "INR"
  );
  const today = dayIn(new Date(), "Asia/Kolkata");
  const next = [];
  await ga.sync(
    {
      secret: ok.secret,
      cursors: { traffic: { cursor: null, synced_through: `${addDays(today, -1)}T00:00:00.000Z` } },
    },
    io().io,
    async (url, init) => {
      if (isToken(url)) return json(200, { access_token: "t" });
      next.push(JSON.parse(init.body).dateRanges[0]);
      return json(200, { rows: [], rowCount: 0 });
    }
  );
  check("the next run starts three days before the last one finished", next[0].startDate === addDays(today, -4));
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\nGoogle's accounts are read as Google writes them");
