// Meta Ads, stood in for (lib/connectors/meta-ads, 0214).
//
// No network: fetch answers as the Graph API's insights do. Holds the
// login (proved once, the token never in an address, a refusal said as
// one), a day's row mapped with Meta's purchases counted once, the
// account's own day, the first run's months walked and paged, the next
// run starting three days back, a run handed on at its deadline, and
// Meta's "slow down" as "later".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-meta-ads.mjs
import { ConnectorBusy, ConnectorRefused, dayIn } from "../src/lib/connectors/kit.ts";
import { adAccountId, login, spendRow, sync } from "../src/lib/connectors/meta-ads.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refusedBy = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

console.log("\nthe ad account's id");
check("act_ and its number stays", adAccountId("act_1234567890") === "act_1234567890");
check("a bare number gains act_", adAccountId(" 1234567890 ") === "act_1234567890");
check("anything else is not one", adAccountId("my shop") === null && adAccountId("") === null);

console.log("\nthe login");
{
  const asked = [];
  const ok = await login({ token: " T0K ", ad_account: "1234567890" }, async (url, init) => {
    asked.push({ url: String(url), auth: init?.headers?.Authorization });
    return json(200, { name: "Carefone Ads", currency: "INR", timezone_name: "Asia/Kolkata", id: "act_1234567890" });
  });
  check(
    "is proved once, against the ad account",
    asked.length === 1 && new URL(asked[0].url).pathname === "/v26.0/act_1234567890"
  );
  check(
    "with the token as a header, never in the address",
    asked[0].auth === "Bearer T0K" && !asked[0].url.includes("T0K")
  );
  const kept = JSON.parse(ok.secret);
  check(
    "and keeps the token, the account and its timezone",
    kept.token === "T0K" && kept.account === "act_1234567890" && kept.timezone === "Asia/Kolkata"
  );
  check(
    "named by the account's own name",
    ok.accountRef === "act_1234567890" && ok.accountLabel === "Carefone Ads (act_1234567890)"
  );

  const missing = await refusedBy(() => login({ token: "", ad_account: "1234567890" }, async () => json(200, {})));
  check("a missing token is refused before any call", missing instanceof ConnectorRefused);
  const expired = await refusedBy(() =>
    login({ token: "old", ad_account: "1234567890" }, async () =>
      json(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } })
    )
  );
  check(
    "a token Meta no longer takes is a refusal",
    expired instanceof ConnectorRefused && /no longer accepts/.test(expired.message)
  );
  const notGiven = await refusedBy(() =>
    login({ token: "t", ad_account: "1234567890" }, async () =>
      json(403, { error: { message: "(#200) Ad account owner has NOT grant ads_management or ads_read", code: 200 } })
    )
  );
  check(
    "a token not given the account says how to give it",
    notGiven instanceof ConnectorRefused && /give the system user the ad account/.test(notGiven.message)
  );
  const busy = await refusedBy(() =>
    login({ token: "t", ad_account: "1234567890" }, async () =>
      json(400, { error: { message: "(#613) Calls to this api have exceeded the rate limit.", code: 613 } })
    )
  );
  check("Meta's rate limit is a wait, not a refusal", busy instanceof ConnectorBusy);
}

console.log("\na day's row");
{
  const row = spendRow({
    campaign_id: "120200000000001",
    campaign_name: " Diwali sale ",
    date_start: "2026-10-12",
    spend: "1250.40",
    impressions: "48211",
    clicks: "903",
    account_currency: "INR",
    actions: [
      { action_type: "link_click", value: "903" },
      { action_type: "purchase", value: "14" },
      { action_type: "omni_purchase", value: "15" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "14" },
    ],
    action_values: [
      { action_type: "omni_purchase", value: "22485.00" },
      { action_type: "purchase", value: "20990.00" },
    ],
  });
  check("its money and counts are numbers", row.spend === 1250.4 && row.impressions === 48211 && row.clicks === 903);
  check("purchases are Meta's omni count, never three overlapping counts added", row.purchases === 15);
  check("and their value the same way", row.purchase_value === 22485);
  check("the campaign keeps its name, trimmed", row.campaign_name === "Diwali sale" && row.currency === "INR");
  const quiet = spendRow({ campaign_id: "1", date_start: "2026-10-12", spend: "80" });
  check("a day with no purchases is zero purchases", quiet.purchases === 0 && quiet.purchase_value === 0);
  check(
    "a row with no campaign or day is skipped",
    spendRow({ date_start: "2026-10-12" }) === null && spendRow({ campaign_id: "1" }) === null
  );
}

console.log("\nthe account's own day");
check(
  "late evening in UTC is the next day in India",
  dayIn(new Date("2026-10-13T20:00:00Z"), "Asia/Kolkata") === "2026-10-14"
);
check("and an unknown timezone is UTC", dayIn(new Date("2026-10-13T20:00:00Z"), "Nowhere/Else") === "2026-10-13");

const io = () => {
  const put = [];
  const cursors = [];
  return {
    put,
    cursors,
    io: {
      deadline: Date.now() + 60_000,
      put: async (list, rows) => put.push(...rows.map((r) => ({ list, ...r }))),
      putCursor: async (resource, cursor, through) => cursors.push({ resource, cursor, through }),
      putSecret: async () => {},
      putShipments: async () => {},
      hookBase: "https://x/",
      putHook: async () => {},
      openShipments: async () => [],
    },
  };
};
const secret = JSON.stringify({ token: "T0K", account: "act_1234567890", timezone: "Asia/Kolkata" });
const today = dayIn(new Date(), "Asia/Kolkata");

console.log("\nthe first run");
{
  const asked = [];
  const run = io();
  const { nextMinutes } = await sync({ secret, cursors: {} }, run.io, async (url, init) => {
    const u = new URL(String(url));
    const range = JSON.parse(u.searchParams.get("time_range"));
    asked.push({
      path: u.pathname,
      range,
      after: u.searchParams.get("after"),
      level: u.searchParams.get("level"),
      inc: u.searchParams.get("time_increment"),
      auth: init?.headers?.Authorization,
    });
    // The first window answers in two pages.
    if (asked.length === 1) {
      return json(200, {
        data: [{ campaign_id: "1", campaign_name: "A", date_start: range.since, spend: "10" }],
        paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/next" },
      });
    }
    return json(200, {
      data: [{ campaign_id: "2", campaign_name: "B", date_start: range.until, spend: "20" }],
      paging: { cursors: { after: "END" } },
    });
  });
  check(
    "reads the account's insights by campaign and day",
    asked.every((a) => a.path === "/v26.0/act_1234567890/insights" && a.level === "campaign" && a.inc === "1")
  );
  check(
    "with the token as a header",
    asked.every((a) => a.auth === "Bearer T0K")
  );
  check("from 90 days back", asked[0].range.since === addDays(today, -90));
  check("through the account's today", asked.at(-1).range.until === today);
  check(
    "in windows of at most 30 days",
    asked.every((a) => Date.parse(a.range.until) - Date.parse(a.range.since) <= 29 * 86_400_000)
  );
  check(
    "following a page to the next with its cursor",
    asked[1].after === "CUR1" && asked[1].range.since === asked[0].range.since
  );
  check("and no further once there is no next page", asked.filter((a) => a.after === "END").length === 0);
  check(
    "every row written, into ad spend",
    run.put.length === asked.length && run.put.every((r) => r.list === "ad_spend")
  );
  check(
    "then where it got to is kept",
    run.cursors.at(-1)?.resource === "insights" && run.cursors.at(-1)?.through?.startsWith(today)
  );
  check("and the next run is in an hour", nextMinutes === 60);
}

console.log("\nthe next run");
{
  const asked = [];
  const through = addDays(today, -1);
  await sync(
    { secret, cursors: { insights: { cursor: null, synced_through: `${through}T00:00:00.000Z` } } },
    io().io,
    async (url) => {
      asked.push(JSON.parse(new URL(String(url)).searchParams.get("time_range")));
      return json(200, { data: [] });
    }
  );
  check(
    "starts three days before where the last one finished, which Meta still revises",
    asked[0].since === addDays(through, -3)
  );
  check("in one window", asked.length === 1 && asked[0].until === today);
}

console.log("\na run out of time");
{
  const run = io();
  run.io.deadline = Date.now() - 1;
  let called = 0;
  const { nextMinutes } = await sync({ secret, cursors: {} }, run.io, async () => {
    called += 1;
    return json(200, { data: [] });
  });
  check("asks nothing more and comes back in five minutes", called === 0 && nextMinutes === 5);
  check("without saying it got further than it did", run.cursors.length === 0);
}

console.log("\nMeta asking us to wait");
{
  const slow = await refusedBy(() => sync({ secret, cursors: {} }, io().io, async () => json(429, {})));
  check("a 429 is a wait", slow instanceof ConnectorBusy);
  const account = await refusedBy(() =>
    sync({ secret, cursors: {} }, io().io, async () =>
      json(400, { error: { message: "(#80004) There have been too many calls to this ad-account.", code: 80004 } })
    )
  );
  check("and so is too many calls to the ad account", account instanceof ConnectorBusy);
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\nMeta Ads is read as Meta writes it");
