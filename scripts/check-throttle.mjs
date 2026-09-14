// Being throttled is not an error.
//
// Shopify meters the Admin API with a leaky bucket, so any import going
// at speed WILL be told to wait. The client used to treat that as a
// failure, stop, and leave a merchant pressing "Try again" to finish
// their own stock levels.
//
// None of that is reachable from a real store on demand — you cannot
// ask Shopify to throttle you — so this stands a fake Shopify up on a
// port and has it behave badly on purpose.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-throttle.mjs

import { createServer } from "node:http";
import { graphql } from "../src/lib/shopify-import.ts";
import { isTransient } from "../src/lib/retry.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** A Shopify that answers however the test says, and counts the calls. */
function fakeShopify(replies) {
  let n = 0;
  const server = createServer((req, res) => {
    const reply = replies[Math.min(n, replies.length - 1)];
    n++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(reply.status, {
        "Content-Type": "application/json",
        ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
      });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        host: `127.0.0.1:${server.address().port}`,
        calls: () => n,
        stop: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

const THROTTLED = {
  status: 200,
  body: {
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions: {
      cost: { requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 10, restoreRate: 100 } },
    },
  },
};
const FINE = { status: 200, body: { data: { products: { nodes: [] } } } };

// The importer builds its own https:// URL, so its fetch is pointed at
// the fake instead — the same call, a different destination.
const realFetch = globalThis.fetch;
const pointAt = (host) => {
  globalThis.fetch = (url, init) =>
    realFetch(String(url).replace(/^https:\/\/[^/]+/, `http://${host}`), init);
};

try {
  console.log("a throttle is a wait, not a failure");
  {
    const fake = await fakeShopify([THROTTLED, FINE]);
    pointAt(fake.host);
    const started = Date.now();
    const data = await graphql("shop.myshopify.com", "tok", "query{}", {});
    const took = Date.now() - started;
    check("the page still arrives", !!data);
    check("after asking again", fake.calls() === 2);
    // 40 points short at 100/sec is 0.4s; the wait should come from
    // what Shopify said, not from a number somebody guessed.
    check("having waited about as long as Shopify said", took >= 400 && took < 3000);
    await fake.stop();
  }

  console.log("\nand so is a 429, or a server having a moment");
  for (const [name, reply] of [
    ["429", { status: 429, retryAfter: "1", body: {} }],
    ["503", { status: 503, body: {} }],
  ]) {
    const fake = await fakeShopify([reply, FINE]);
    pointAt(fake.host);
    check(`${name} is ridden out`, !!(await graphql("shop.myshopify.com", "tok", "query{}", {})));
    check(`${name} took a second call`, fake.calls() === 2);
    await fake.stop();
  }

  console.log("\nbut a real refusal is not retried");
  {
    const fake = await fakeShopify([
      { status: 200, body: { errors: [{ message: "Field 'nope' doesn't exist" }] } },
    ]);
    pointAt(fake.host);
    let message = "";
    try {
      await graphql("shop.myshopify.com", "tok", "query{}", {});
    } catch (e) {
      message = e.message;
    }
    check("it is raised at once", /doesn't exist/.test(message));
    check("without asking again", fake.calls() === 1);
    await fake.stop();
  }
  {
    const fake = await fakeShopify([{ status: 401, body: {} }]);
    pointAt(fake.host);
    let threw = false;
    try {
      await graphql("shop.myshopify.com", "tok", "query{}", {});
    } catch {
      threw = true;
    }
    check("a bad token fails immediately", threw && fake.calls() === 1);
    await fake.stop();
  }

  console.log("\nand something broken the whole time gives up");
  {
    const fake = await fakeShopify([THROTTLED]);
    pointAt(fake.host);
    let err = null;
    try {
      await graphql("shop.myshopify.com", "tok", "query{}", {});
    } catch (e) {
      err = e;
    }
    check("it stops rather than loops", fake.calls() === 3);
    check("and the failure it reports is one a caller may retry", isTransient(err));
    await fake.stop();
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(fails.length === 0 ? "\na throttle no longer stops an import" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
