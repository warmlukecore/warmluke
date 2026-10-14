// Zendesk and HubSpot, stood in for (lib/connectors/zendesk, hubspot, 0215).
//
// No network: fetch answers as their APIs do. Holds the logins (a
// Zendesk login it does not recognise answering as an anonymous user, a
// HubSpot app without the contacts scope), a ticket on the person who
// raised it, Zendesk's export carried on from its cursor page by page,
// a contact's name, phone and link, and HubSpot's search walked oldest
// change first, starting again past its ten-thousand cap.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-support-crm-connectors.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import * as zendesk from "../src/lib/connectors/zendesk.ts";
import * as hubspot from "../src/lib/connectors/hubspot.ts";

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

console.log("\nZendesk");
{
  check(
    "a subdomain is read however it is pasted",
    zendesk.subdomainOf("https://Chai.zendesk.com/agent/x") === "chai" &&
      zendesk.subdomainOf("chai") === "chai" &&
      zendesk.subdomainOf("") === null
  );
  const asked = [];
  const ok = await zendesk.login(
    { subdomain: "chai.zendesk.com", email: "Agent@Chai.in", api_token: "tok" },
    async (url, init) => {
      asked.push({ url: String(url), auth: init.headers.Authorization });
      return json(200, { user: { id: 42, role: "admin" } });
    }
  );
  check(
    "the login is proved once, on the account",
    asked.length === 1 && asked[0].url === "https://chai.zendesk.com/api/v2/users/me.json"
  );
  check(
    "as Zendesk's email/token login",
    Buffer.from(asked[0].auth.replace("Basic ", ""), "base64").toString() === "agent@chai.in/token:tok"
  );
  check("named by the account", ok.accountLabel === "chai.zendesk.com");
  const anonymous = await caught(() =>
    zendesk.login({ subdomain: "chai", email: "x@y.in", api_token: "bad" }, async () =>
      json(200, { user: { id: null, role: "end-user" } })
    )
  );
  check("a login Zendesk does not recognise is refused", anonymous instanceof ConnectorRefused);

  const row = zendesk.ticketRow(
    {
      id: 9,
      subject: "Where is my order?",
      status: "open",
      priority: "high",
      via: { channel: "email" },
      requester_id: 5,
      created_at: "2026-10-10T09:00:00Z",
      updated_at: "2026-10-11T09:00:00Z",
      tags: ["wismo"],
    },
    new Map([[5, { id: 5, name: "Asha", email: "asha@x.in", phone: "+91 98765 43210" }]]),
    "chai"
  );
  check(
    "a ticket carries the person who raised it",
    row.requester_email === "asha@x.in" && row.requester_phone === "+91 98765 43210" && row.channel === "email"
  );
  check("and a link to it in Zendesk", row.url === "https://chai.zendesk.com/agent/tickets/9");

  const run = io();
  const paths = [];
  const { nextMinutes } = await zendesk.sync(
    { secret: ok.secret, cursors: { tickets: { cursor: "C1", synced_through: null } } },
    run.io,
    async (url) => {
      paths.push(String(url));
      return paths.length === 1
        ? json(200, {
            tickets: [{ id: 1, requester_id: 5 }],
            users: [{ id: 5, email: "a@x.in" }],
            after_cursor: "C2",
            end_of_stream: false,
          })
        : json(200, { tickets: [{ id: 2 }], users: [], after_cursor: "C3", end_of_stream: true });
    }
  );
  check(
    "carries on from the cursor it stopped at",
    paths[0].includes("cursor=C1") && paths[0].includes("include=users")
  );
  check("keeping each page's cursor as it lands", run.cursors[0]?.cursor === "C2" && !run.cursors[0]?.through);
  check(
    "and says when it caught up",
    run.cursors.at(-1)?.cursor === "C3" && !!run.cursors.at(-1)?.through && nextMinutes === 30
  );
  check(
    "every ticket written",
    run.put.support_tickets?.length === 2 && run.put.support_tickets[0].requester_email === "a@x.in"
  );
  const first = [];
  await zendesk.sync({ secret: ok.secret, cursors: {} }, io().io, async (url) => {
    first.push(String(url));
    return json(200, { tickets: [], end_of_stream: true });
  });
  const start = Number(/start_time=(\d+)/.exec(first[0])?.[1]);
  check("the first run starts 90 days back", start < Date.now() / 1000 - 89 * 86400);
  const busy = await caught(() => zendesk.sync({ secret: ok.secret, cursors: {} }, io().io, async () => json(429, {})));
  check("Zendesk's limit is a wait", busy instanceof ConnectorBusy);
}

console.log("\nHubSpot");
{
  const noScope = await caught(() =>
    hubspot.login({ token: "pat-x" }, async () => json(403, { category: "MISSING_SCOPES" }))
  );
  check(
    "an app without the contacts scope says which to give",
    noScope instanceof ConnectorRefused && /crm\.objects\.contacts\.read/.test(noScope.message)
  );
  const ok = await hubspot.login({ token: "pat-x" }, async (url) =>
    String(url).includes("account-info")
      ? json(200, { portalId: 4455, uiDomain: "app-na2.hubspot.com" })
      : json(200, { results: [] })
  );
  check("named by the account", ok.accountLabel === "HubSpot account 4455");
  const row = hubspot.contactRow(
    {
      id: "77",
      properties: {
        firstname: "Ravi",
        lastname: " Shah",
        mobilephone: "9876543210",
        email: "ravi@x.in",
        lifecyclestage: "customer",
        lastmodifieddate: "2026-10-11T00:00:00Z",
      },
    },
    4455,
    "app-na2.hubspot.com"
  );
  check(
    "a contact keeps a name, and a mobile when there is no phone",
    row.name === "Ravi Shah" && row.phone === "9876543210"
  );
  check("and a link to it in HubSpot", row.url === "https://app-na2.hubspot.com/contacts/4455/record/0-1/77");

  const bodies = [];
  const run = io();
  await hubspot.sync(
    { secret: ok.secret, cursors: { contacts: { cursor: null, synced_through: "2026-10-01T00:00:00.000Z" } } },
    run.io,
    async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return json(200, {
          results: [{ id: "1", properties: { lastmodifieddate: "2026-10-05T00:00:00.000Z" } }],
          paging: { next: { after: "100" } },
        });
      }
      return json(200, { results: [{ id: "2", properties: { lastmodifieddate: "2026-10-06T00:00:00.000Z" } }] });
    }
  );
  check(
    "reads contacts changed since the last run, oldest change first",
    bodies[0].filterGroups[0].filters[0].value === String(Date.parse("2026-10-01T00:00:00.000Z")) &&
      bodies[0].sorts[0].direction === "ASCENDING"
  );
  check("a page at a time", bodies[1].after === "100" && run.put.crm_contacts?.length === 2);
  check("then keeps the last change it saw", run.cursors.at(-1)?.through === "2026-10-06T00:00:00.000Z");

  // A hundred full pages are HubSpot's ten thousand: the walk must start a fresh query.
  let calls = 0;
  let fresh = null;
  await hubspot.sync({ secret: ok.secret, cursors: {} }, io().io, async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (calls <= 100) {
      const day = calls < 50 ? "01" : "02";
      return json(200, {
        results: Array.from({ length: 100 }, (_, i) => ({
          id: `${calls}-${i}`,
          properties: { lastmodifieddate: `2026-10-${day}T00:00:00.000Z` },
        })),
        paging: { next: { after: String(calls * 100) } },
      });
    }
    fresh = body;
    return json(200, { results: [] });
  });
  check(
    "past ten thousand, a fresh query starts from the last change seen",
    calls === 101 &&
      !fresh?.after &&
      fresh?.filterGroups[0].filters[0].value === String(Date.parse("2026-10-02T00:00:00.000Z"))
  );
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\ntickets and contacts are read as Zendesk and HubSpot write them");
