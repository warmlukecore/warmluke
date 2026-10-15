// Klaviyo and WhatsApp Business, stood in for (lib/connectors/klaviyo, whatsapp, 0216).
//
// No network: fetch answers as their APIs do. Holds Klaviyo's key, its
// revision and the "Placed Order" metric found past a page, a campaign
// summed over its messages with its subject, the one report a run, and
// counts left out with no metric to count them on; WhatsApp's account
// proved and its insights turned on, a template's day on the account's
// own calendar, its clicks summed, and templates asked after ten at a time.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-klaviyo-whatsapp.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import * as klaviyo from "../src/lib/connectors/klaviyo.ts";
import * as whatsapp from "../src/lib/connectors/whatsapp.ts";

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

console.log("\nKlaviyo");
{
  const wrong = await caught(() => klaviyo.login({ api_key: "abc" }, async () => json(200, {})));
  check("a key that is not a private key is refused before any call", wrong instanceof ConnectorRefused);
  const asked = [];
  const ok = await klaviyo.login({ api_key: "pk_live1" }, async (url, init) => {
    asked.push({ url: String(url), auth: init.headers.Authorization, revision: init.headers.revision });
    if (String(url).includes("/accounts/")) {
      return json(200, {
        data: [
          {
            id: "ACC1",
            attributes: { contact_information: { organization_name: "Chai Co" }, preferred_currency: "INR" },
          },
        ],
      });
    }
    return String(url).includes("page2")
      ? json(200, { data: [{ id: "PO1", attributes: { name: "Placed Order" } }], links: { next: null } })
      : json(200, {
          data: [{ id: "M0", attributes: { name: "Opened Email" } }],
          links: { next: "https://a.klaviyo.com/api/metrics/?page2" },
        });
  });
  check(
    "the key goes as Klaviyo's header with the revision it is written for",
    asked.every((a) => a.auth === "Klaviyo-API-Key pk_live1" && a.revision === "2026-07-15")
  );
  const kept = JSON.parse(ok.secret);
  check("the Placed Order metric is found past a page", kept.metric === "PO1" && asked.length === 3);
  check("named by the account, its currency kept", ok.accountLabel === "Chai Co" && kept.currency === "INR");

  const campaigns = [
    {
      id: "C1",
      attributes: { name: " Diwali ", send_time: "2026-10-10T08:00:00+00:00" },
      relationships: { "campaign-messages": { data: [{ id: "MSG1" }] } },
    },
    { id: "C2", attributes: { name: "Draft", send_time: null } },
  ];
  const included = [
    { id: "MSG1", type: "campaign-message", attributes: { definition: { content: { subject: "Lights!" } } } },
  ];
  const results = [
    {
      groupings: { campaign_id: "C1", campaign_message_id: "MSG1" },
      statistics: { recipients: 600, opens_unique: 200, conversion_value: 9000, conversions: 6 },
    },
    {
      groupings: { campaign_id: "C1", campaign_message_id: "MSG2" },
      statistics: { recipients: 400, opens_unique: 100, conversion_value: 1000, conversions: 1 },
    },
  ];
  const rows = klaviyo.campaignRows(campaigns, included, results, "INR", true);
  check("a draft with no send time is left out", rows.length === 1);
  check(
    "a campaign is the sum of its messages",
    rows[0].sent === 1000 && rows[0].opens === 300 && rows[0].revenue === 10000 && rows[0].orders === 7
  );
  check(
    "with its subject and name",
    rows[0].subject === "Lights!" && rows[0].name === "Diwali" && rows[0].currency === "INR"
  );
  const uncounted = klaviyo.campaignRows(campaigns, included, results, "INR", false);
  check(
    "with no Placed Order metric, no orders or revenue are claimed",
    uncounted[0].orders === null && uncounted[0].revenue === null
  );

  const run = io();
  const calls = [];
  const { nextMinutes } = await klaviyo.sync({ secret: ok.secret, cursors: {} }, run.io, async (url, init) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes("campaign-values-reports")) return json(200, { data: { attributes: { results } } });
    return calls.filter((c) => c.url.includes("/campaigns/")).length === 1
      ? json(200, {
          data: [campaigns[0]],
          included,
          links: { next: "https://a.klaviyo.com/api/campaigns/?page2" },
        })
      : json(200, { data: [campaigns[1]], links: { next: null } });
  });
  const listing = decodeURIComponent(calls[0].url);
  check(
    "asks for email campaigns changed in the span",
    listing.includes("equals(messages.channel,'email')") && listing.includes("greater-or-equal(updated_at,")
  );
  check("following their pages", calls.filter((c) => c.url.includes("/campaigns/")).length === 2);
  const report = calls.find((c) => c.url.includes("campaign-values-reports"));
  check(
    "then one report, counted on the Placed Order metric",
    calls.filter((c) => c.url.includes("campaign-values-reports")).length === 1 &&
      report.body.data.attributes.conversion_metric_id === "PO1" &&
      report.body.data.attributes.statistics.includes("conversion_value")
  );
  check("into email campaigns", run.put.email_campaigns?.length === 1 && nextMinutes === 360);
  check("then where it got to is kept", run.cursors.at(-1)?.resource === "campaigns");
  const busy = await caught(() => klaviyo.sync({ secret: ok.secret, cursors: {} }, io().io, async () => json(429, {})));
  check("Klaviyo's limit is a wait", busy instanceof ConnectorBusy);
  const refused = await caught(() =>
    klaviyo.sync({ secret: ok.secret, cursors: {} }, io().io, async () =>
      json(401, { errors: [{ detail: "Invalid API key" }] })
    )
  );
  check(
    "a key it no longer takes asks the owner, in Klaviyo's words",
    refused instanceof ConnectorRefused && /Invalid API key/.test(refused.message)
  );
}

console.log("\nWhatsApp Business");
{
  const bad = await caught(() => whatsapp.login({ token: "t", waba_id: "abc" }, async () => json(200, {})));
  check("an account id that is not one is refused before any call", bad instanceof ConnectorRefused);
  const asked = [];
  const ok = await whatsapp.login({ token: "SYS", waba_id: "1122334455" }, async (url, init) => {
    asked.push({ url: new URL(String(url)), method: init.method, auth: init.headers.Authorization });
    return json(200, init.method === "POST" ? { success: true } : { name: "Chai Co WhatsApp" });
  });
  check("the account is read", asked[0].method === "GET" && asked[0].url.pathname.endsWith("/1122334455"));
  check(
    "and its template insights turned on",
    asked[1].method === "POST" && asked[1].url.searchParams.get("is_enabled_for_insights") === "true"
  );
  check(
    "with the token as a header",
    asked.every((a) => a.auth === "Bearer SYS" && !a.url.href.includes("SYS"))
  );
  check("named by the account", ok.accountLabel === "Chai Co WhatsApp");

  // India's midnight on 12 Oct is 18:30 UTC on the 11th.
  const istMidnight = Date.parse("2026-10-11T18:30:00Z") / 1000;
  check("a point starting at the account's midnight is that day", whatsapp.dayOf(istMidnight) === "2026-10-12");
  const row = whatsapp.statRow(
    {
      template_id: "T1",
      start: istMidnight,
      sent: 120,
      delivered: 115,
      read: 90,
      clicked: [{ count: 7 }, { count: 3 }],
    },
    { id: "T1", name: "cod_confirm", category: "UTILITY", language: "en" }
  );
  check(
    "a template's day keeps its counts, its clicks summed over buttons",
    row.sent === 120 &&
      row.read === 90 &&
      row.clicked === 10 &&
      row.template_name === "cod_confirm" &&
      row.category === "utility"
  );

  const run = io();
  const calls = [];
  const templates = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, name: `t${i}` }));
  await whatsapp.sync({ secret: ok.secret, cursors: {} }, run.io, async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.pathname.endsWith("/message_templates")) {
      return u.searchParams.get("after")
        ? json(200, { data: templates.slice(6) })
        : json(200, { data: templates.slice(0, 6), paging: { cursors: { after: "A" }, next: "n" } });
    }
    const ids = JSON.parse(u.searchParams.get("template_ids"));
    return json(200, { data: [{ data_points: ids.map((id) => ({ template_id: id, start: istMidnight, sent: 1 })) }] });
  });
  const analytics = calls.filter((u) => u.pathname.endsWith("/template_analytics"));
  check(
    "every template is listed, page by page",
    calls.filter((u) => u.pathname.endsWith("/message_templates")).length === 2
  );
  check(
    "and asked after ten at a time",
    analytics.length === 2 && JSON.parse(analytics[0].searchParams.get("template_ids")).length === 10
  );
  check(
    "daily, on the account's own calendar",
    analytics[0].searchParams.get("granularity") === "DAILY" &&
      analytics[0].searchParams.get("use_waba_timezone") === "true"
  );
  check("into WhatsApp messages", run.put.message_stats?.length === 12 && run.cursors.at(-1)?.resource === "templates");
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\nemail and WhatsApp counts are read as Klaviyo and WhatsApp write them");
