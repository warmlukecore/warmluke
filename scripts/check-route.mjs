// The router reads a question and names a list, a span and a kind — or
// says nothing. What has to hold without a model: the words worth
// looking up are found by rule, a span becomes the right days in the
// shop's own zone, and every reason to say nothing says nothing: no
// key, not sure, not a question, a broken answer, a slow one.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-route.mjs
//
// With TYPESAFE_API_KEY in the environment or the env file, one real
// question goes out at the end and its route is printed.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { candidates, routeQuestion } from "../src/lib/route.ts";
import { windowRange } from "../src/lib/slice.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const realKey = process.env.TYPESAFE_API_KEY ?? "";

console.log("the words worth looking up");
{
  const c = candidates("Aman ka phone number kya hai");
  check("a name at the start of the sentence", c.includes("Aman"));
  check("and not the filler around it", !c.includes("ka") && !c.includes("kya") && !c.includes("hai"));
  check("an order number as written", candidates("is #1004 paid?").includes("#1004"));
  check("a two-word product, lower case and all", candidates("stock of ski wax").includes("ski wax"));
  check("never more than twenty", candidates(Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")).length <= 20);
  check("nothing from nothing", candidates("hi").length === 0);
}

console.log("\na span, as days in the shop's zone");
{
  const now = new Date("2026-09-20T10:00:00Z");
  const tz = "Asia/Kolkata";
  const w = (window, month = null) => windowRange({ window, month }, tz, now);
  check("today is one day", w("today")?.fromDay === "2026-09-20" && w("today")?.toDay === "2026-09-20");
  check("and starts at the shop's midnight, not the server's", w("today")?.from === "2026-09-19T18:30:00.000Z");
  check("yesterday", w("yesterday")?.fromDay === "2026-09-19" && w("yesterday")?.toDay === "2026-09-19");
  check(
    "the last seven days end today",
    w("this_week")?.fromDay === "2026-09-14" && w("this_week")?.toDay === "2026-09-20"
  );
  check("the last thirty too", w("this_month")?.fromDay === "2026-08-22");
  check(
    "last month is the whole of August",
    w("last_month")?.fromDay === "2026-08-01" && w("last_month")?.toDay === "2026-08-31"
  );
  check(
    "a named month this year",
    w("named_month", 8)?.fromDay === "2026-08-01" && w("named_month", 8)?.label === "August 2026"
  );
  check(
    "a month not yet reached is last year's",
    w("named_month", 12)?.fromDay === "2025-12-01" && w("named_month", 12)?.toDay === "2025-12-31"
  );
  check("February knows its length", w("named_month", 2)?.toDay === "2026-02-28");
  check("all time is no span", w("all") === null);
  check("a named month with no month is no span", w("named_month", null) === null);
}

/** A Jev that answers however the test says. */
function fakeJev(reply) {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      process.env.TYPESAFE_API_URL = `http://127.0.0.1:${server.address().port}/v1/systemone`;
      resolve({
        calls: () => calls,
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
const answers = (o) => ({
  model: "jev-1.13.0",
  answers: {
    list: { type: "choice", choice: o.list ?? "customers", confidence: o.listC ?? 0.9 },
    window: { type: "choice", choice: o.window ?? "all", confidence: 0.9 },
    month: { type: "choice", choice: o.month ?? "none", confidence: 0.9 },
    kind: { type: "choice", choice: o.kind ?? "ranking", confidence: o.kindC ?? 0.9 },
  },
});

console.log("\nevery reason to say nothing");
{
  delete process.env.TYPESAFE_API_KEY;
  const jev = await fakeJev({ body: answers({}) });
  check("no key: no route", (await routeQuestion("who is my top buyer?")) === null);
  check("and nothing was sent", jev.calls() === 0);
  await jev.close();
}
process.env.TYPESAFE_API_KEY = "check-key-not-real";
const routed = async (o, text = "who is my top buyer?") => {
  const jev = await fakeJev({ body: answers(o) });
  const r = await routeQuestion(text);
  await jev.close();
  return r;
};
check("sure about a question: a route", (await routed({}))?.list === "customers");
check(
  "with the words to look up along",
  (await routed({ kind: "lookup" }, "Aman ka phone number"))?.needles.includes("Aman")
);
check("not sure which list: nothing", (await routed({ listC: 0.4 })) === null);
check("not sure what kind: nothing", (await routed({ kindC: 0.3 })) === null);
check("a request to build: nothing", (await routed({ kind: "build" })) === null);
check("small talk: nothing", (await routed({ kind: "unclear", list: "none" })) === null);
check("not about any list: nothing", (await routed({ list: "none" })) === null);
check("a named month carries its number", (await routed({ window: "named_month", month: "aug" }))?.month === 8);
check(
  "a named month with no name falls back to all time",
  (await routed({ window: "named_month", month: "none" }))?.window === "all"
);
check("a span the code does not know reads as all time", (await routed({ window: "fortnight" }))?.window === "all");
{
  const jev = await fakeJev({ status: 500, body: { error: "boom" } });
  check("a broken model: nothing", (await routeQuestion("who is my top buyer?")) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ body: "<html>gateway</html>" });
  check("a page instead of JSON: nothing", (await routeQuestion("who is my top buyer?")) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ hang: true });
  const t0 = Date.now();
  check(
    "a slow model: nothing, and soon",
    (await routeQuestion("who is my top buyer?", 300)) === null && Date.now() - t0 < 2000
  );
  await jev.close();
}
check("two letters are not a question", (await routed({}, "hi")) === null);

console.log("\nand once, for real");
{
  delete process.env.TYPESAFE_API_URL;
  const envFile = new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url);
  const fromFile = existsSync(envFile)
    ? (readFileSync(envFile, "utf8")
        .match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]
        ?.trim() ?? "")
    : "";
  const key = realKey || fromFile;
  if (!key) {
    console.log("  skip  no TYPESAFE_API_KEY — the real call was not made");
  } else {
    process.env.TYPESAFE_API_KEY = key;
    const r = await routeQuestion("August ka top buyer kaun tha?");
    console.log(
      `  →     ${r ? `${r.list} · ${r.window} · month ${r.month} · ${r.kind} · list ${Math.round(r.confidence.list * 100)}% kind ${Math.round(r.confidence.kind * 100)}% · ${r.ms}ms` : "no route"}`
    );
    check("a real question routes", r !== null);
    check("to customers, ranked, in August", r?.list === "customers" && r?.kind === "ranking" && r?.month === 8);
    const b = await routeQuestion("make me a returns section with a reason and refund amount");
    check("and a build request does not", b === null);
  }
}

console.log(fails.length === 0 ? "\nthe router reads, or says nothing" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
