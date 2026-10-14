// Mailchimp and Brevo, stood in for (lib/connectors/mailchimp, brevo, 0215).
//
// No network: fetch answers as their APIs do. Holds the keys (a
// Mailchimp key's data centre, Brevo's prefix, each proved once and a
// refusal said as one), a campaign mapped with its opens, clicks and
// bounces counted as each provider counts them, the pages walked, and
// each run reading back a month for the opens still arriving.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-email-connectors.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import * as mailchimp from "../src/lib/connectors/mailchimp.ts";
import * as brevo from "../src/lib/connectors/brevo.ts";

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
    },
  };
};
const KEY = `${"a".repeat(32)}-us21`;

console.log("\nMailchimp");
{
  check(
    "a key's data centre is its end",
    mailchimp.dataCentre(KEY) === "us21" && mailchimp.dataCentre("nope") === null
  );
  const asked = [];
  const ok = await mailchimp.login({ api_key: KEY }, async (url, init) => {
    asked.push({ url: String(url), auth: init.headers.Authorization });
    return json(200, { account_id: "acc1", account_name: "Chai Co", email: "o@chai.in" });
  });
  check(
    "the key is proved once, at its own data centre",
    asked.length === 1 && asked[0].url === "https://us21.api.mailchimp.com/3.0/"
  );
  check(
    "as Mailchimp's basic login, never in the address",
    Buffer.from(asked[0].auth.replace("Basic ", ""), "base64").toString().endsWith(`:${KEY}`) &&
      !asked[0].url.includes(KEY)
  );
  check("named by the account", ok.accountLabel === "Chai Co" && ok.accountRef === "acc1");
  const wrong = await caught(() =>
    mailchimp.login({ api_key: KEY }, async () => json(401, { detail: "Your API key may be invalid." }))
  );
  check(
    "a refused key is said in Mailchimp's words",
    wrong instanceof ConnectorRefused && /may be invalid/.test(wrong.message)
  );
  const row = mailchimp.campaignRow({
    id: "c1",
    campaign_title: "Diwali drop",
    subject_line: "Lights, sale, action",
    send_time: "2026-10-10T08:00:00+00:00",
    emails_sent: 1000,
    unsubscribed: 4,
    bounces: { hard_bounces: 10, soft_bounces: 15 },
    opens: { unique_opens: 420 },
    clicks: { unique_subscriber_clicks: 61 },
    ecommerce: { total_orders: 9, total_revenue: 12890, currency_code: "INR" },
  });
  check(
    "a campaign keeps its opens, clicks and what it sold",
    row.opens === 420 && row.clicks === 61 && row.orders === 9 && row.revenue === 12890 && row.currency === "INR"
  );
  check("delivered is what was sent less what bounced", row.delivered === 975 && row.bounces === 25);

  const run = io();
  const pages = [];
  const through = "2026-10-01T00:00:00.000Z";
  await mailchimp.sync(
    { secret: ok.secret, cursors: { reports: { cursor: null, synced_through: through } } },
    run.io,
    async (url) => {
      const u = new URL(String(url));
      pages.push(u);
      const offset = Number(u.searchParams.get("offset"));
      return json(200, { reports: [{ id: `r${offset}`, emails_sent: 10 }], total_items: 150 });
    }
  );
  check(
    "reads back a month before the last run, for opens still arriving",
    pages[0].searchParams.get("since_send_time") === "2026-09-01T00:00:00.000Z"
  );
  check(
    "a page at a time until every report is read",
    pages.length === 2 && pages[1].searchParams.get("offset") === "100"
  );
  check("into email campaigns", run.put.email_campaigns?.length === 2 && run.cursors.at(-1)?.resource === "reports");
  const busy = await caught(() =>
    mailchimp.sync({ secret: ok.secret, cursors: {} }, io().io, async () => json(429, {}))
  );
  check("Mailchimp's limit is a wait", busy instanceof ConnectorBusy);
}

console.log("\nBrevo");
{
  const missing = await caught(() => brevo.login({ api_key: "abc" }, async () => json(200, {})));
  check("a key that is not Brevo's is refused before any call", missing instanceof ConnectorRefused);
  const asked = [];
  const ok = await brevo.login({ api_key: "xkeysib-123" }, async (url, init) => {
    asked.push({ url: String(url), key: init.headers["api-key"] });
    return json(200, { email: "o@chai.in", companyName: "Chai Co" });
  });
  check(
    "the key is proved once, in Brevo's header",
    asked.length === 1 && asked[0].url.endsWith("/v3/account") && asked[0].key === "xkeysib-123"
  );
  check("named by the company", ok.accountLabel === "Chai Co");
  const row = brevo.campaignRow({
    id: 7,
    name: "Weekend",
    subject: "48 hours only",
    sentDate: "2026-10-11T05:30:00.000Z",
    statistics: {
      globalStats: {
        sent: 800,
        delivered: 790,
        uniqueViews: 300,
        uniqueClicks: 40,
        unsubscriptions: 2,
        hardBounces: 4,
        softBounces: 6,
      },
    },
  });
  check(
    "a campaign keeps Brevo's own counts",
    row.campaign_ref === "7" && row.delivered === 790 && row.opens === 300 && row.clicks === 40 && row.bounces === 10
  );
  check("and no revenue Brevo does not keep", row.revenue === null && row.orders === null);
  const run = io();
  const pages = [];
  await brevo.sync({ secret: ok.secret, cursors: {} }, run.io, async (url) => {
    const u = new URL(String(url));
    pages.push(u);
    return json(200, { campaigns: [{ id: Number(u.searchParams.get("offset")) + 1 }], count: 60 });
  });
  check(
    "reads sent campaigns with their statistics",
    pages[0].searchParams.get("status") === "sent" && pages[0].searchParams.get("statistics") === "globalStats"
  );
  check("50 a page until every one is read", pages.length === 2 && pages[1].searchParams.get("offset") === "50");
  check("into email campaigns", run.put.email_campaigns?.length === 2);
  const refused = await caught(() =>
    brevo.sync({ secret: ok.secret, cursors: {} }, io().io, async () => json(401, { message: "Key not found" }))
  );
  check(
    "a key Brevo no longer takes asks the owner",
    refused instanceof ConnectorRefused && /Key not found/.test(refused.message)
  );
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\nemail campaigns are read as each provider writes them");
