// What a stranger with the public key can do.
//
// The anon key is not a secret — it ships in the browser bundle of
// every page. So the question this file asks is the only one that
// matters about the webhook path: holding that key and nothing else,
// can somebody write into a merchant's store?
//
// Until 0037 the answer was yes, including erasing one outright. The
// signature was checked in the Next.js route, and an attacker has no
// reason to use the route.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-webhook-gate.mjs

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { webhookAddress } from "../src/lib/shopify.ts";
import { realStores } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

// Exactly what a stranger has: the URL and the anon key.
const stranger = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
// Used only to read the store back and to put it right afterwards.
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

let store = null;
let lookup = null;
try {
  [store = null] = await realStores(admin, "id, shop_domain");
} catch (e) {
  lookup = e;
}
// A query that could not run is not an empty result. This exited 0
// saying "nothing to check" while the fetch underneath had failed
// outright — a security check that reports success when it cannot
// reach the thing it guards is worse than one that is missing.
if (lookup) {
  console.log(`could not look for a store: ${lookup.message}`);
  process.exit(1);
}
if (!store) {
  console.log("no connected store — nothing to check");
  process.exit(0);
}
const countOf = async (table) =>
  (await admin.from(table).select("*", { count: "exact", head: true }).eq("store_id", store.id))
    .count;

console.log("holding only the public key");
/**
 * Refused by the guard, not by an accident.
 *
 * This used to be `!!error`, and any error counted — including
 * PostgREST failing to find the function at all. Two checks here spent
 * a day green while calling a signature that no longer existed, never
 * reaching the gate they were written to test. A tick for the wrong
 * reason is worse than a cross.
 */
const refused = async (fn, args) => {
  const { error } = await stranger.rpc(fn, args);
  if (!error) return false;
  // Naming the code rather than excluding the failures we thought of:
  // every guard here refuses with 42501, whether the grant stopped the
  // call or the function raised. Anything else — a function that could
  // not be resolved, a bad argument, a column that moved — is this
  // check breaking, and has to read as one.
  if (error.code !== "42501") {
    console.log(`     ..    ${fn} did not refuse, it broke [${error.code}]: ${error.message.slice(0, 80)}`);
    return false;
  }
  return true;
};

check(
  "cannot write an order",
  await refused("abo_shopify_upsert_order", {
    p_shop: store.shop_domain,
    p_order: { id: 1, name: "#forged" },
  })
);
check(
  "cannot rewrite a product",
  await refused("abo_shopify_upsert_product", {
    p_shop: store.shop_domain,
    p_product: { id: 1, title: "forged" },
  })
);
check(
  "cannot move stock",
  await refused("abo_shopify_set_inventory", {
    p_shop: store.shop_domain,
    p_level: { inventory_item_id: 1, location_id: 1, available: 0 },
  })
);

// The one that mattered most: this erases a merchant's imported data.
const ordersBefore = await countOf("orders");
const productsBefore = await countOf("products");
check(
  "cannot erase the store",
  await refused("abo_shopify_shop_redact", { p_shop: store.shop_domain })
);
check(
  "and the store is still there",
  (await countOf("orders")) === ordersBefore && (await countOf("products")) === productsBefore
);

// Everything below signs as Shopify, which takes the app's secret. The
// check project's env holds none, so there this proves the half above,
// the half a stranger has, and says it stopped rather than crashing on
// an undefined key.
if (!env.SHOPIFY_CLIENT_SECRET) {
  console.log("\n  skip  no SHOPIFY_CLIENT_SECRET — nothing was signed as Shopify, so the webhook doors were not tried");
  console.log(fails.length === 0 ? "\nthe public key opens nothing" : `\n${fails.length} FAILED`);
  process.exit(fails.length === 0 ? 0 : 1);
}

console.log("\nthe one door it can knock on");
// The shop is no longer something a caller says. Each store has its
// own webhook address and the last segment of it — hmac(shop, app
// secret) — is what the database looks the store up from. The route
// used to read the shop from a header and then sign it, which made the
// route itself an oracle: replay a real signed body through it naming
// somebody else's shop and it handed back a valid signature.
const address = webhookAddress(store.shop_domain, env.SHOPIFY_CLIENT_SECRET);
const body = JSON.stringify({ id: 987654321, title: "forged by a stranger" });
check(
  "an unsigned call is refused",
  await refused("abo_shopify_webhook", {
    p_token: address,
    p_topic: "products/update",
    p_raw: body,
    p_hmac: null,
  })
);
check(
  "a made-up signature is refused",
  await refused("abo_shopify_webhook", {
    p_token: address,
    p_topic: "products/update",
    p_raw: body,
    p_hmac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  })
);
check("and nothing was written", (await countOf("products")) === productsBefore);

console.log("\nand Shopify itself still gets through");
const { data: product } = await admin
  .from("products")
  .select("id, external_id, title")
  .eq("store_id", store.id)
  .limit(1)
  .maybeSingle();
if (product) {
  const real = JSON.stringify({
    id: String(product.external_id).split("/").pop(),
    title: "Signed by Shopify",
    updated_at: new Date().toISOString(),
  });
  const hmac = createHmac("sha256", env.SHOPIFY_CLIENT_SECRET).update(real).digest("base64");
  const { error } = await stranger.rpc("abo_shopify_webhook", {
    p_token: address,
    p_topic: "products/update",
    p_raw: real,
    p_hmac: hmac,
  });
  check("a properly signed webhook is accepted", !error);
  const row = (await admin.from("products").select("title").eq("id", product.id).single()).data;
  check("and the write really happened", row.title === "Signed by Shopify");
  await admin.from("products").update({ title: product.title }).eq("id", product.id);

  // The body carries a valid Shopify signature — that secret belongs
  // to the whole app, so it proves Shopify sent it and never which
  // shop it came from. The address is what decides that now.
  // Named for what it actually proves. someone-else.myshopify.com is
  // not a store here, so this is an address matching no row — the same
  // class as the all-zero token below, and NOT a demonstration that a
  // second real store's address would be refused. It would not be:
  // holding a real store's address plus any app-signed body is enough
  // to write to that store, and that is the ceiling this design
  // accepts. What it does prove is that the shop is chosen by the
  // address and never by anything the caller says.
  const unknownAddress = await stranger.rpc("abo_shopify_webhook", {
    p_token: webhookAddress("someone-else.myshopify.com", env.SHOPIFY_CLIENT_SECRET),
    p_topic: "products/update",
    p_raw: real,
    p_hmac: hmac,
  });
  check("a body aimed at a shop we do not hold writes nothing", !!unknownAddress.error);
  check(
    "and an address for no store at all is refused",
    await refused("abo_shopify_webhook", {
      p_token: "00".repeat(32),
      p_topic: "products/update",
      p_raw: real,
      p_hmac: hmac,
    })
  );
  check(
    "as is no address",
    await refused("abo_shopify_webhook", {
      p_token: null,
      p_topic: "products/update",
      p_raw: real,
      p_hmac: hmac,
    })
  );

  // An address cannot be worked out from the shop name alone: without
  // the app secret there is nothing to compute it from.
  check(
    "and the shop name alone does not open it",
    await refused("abo_shopify_webhook", {
      p_token: store.shop_domain,
      p_topic: "products/update",
      p_raw: real,
      p_hmac: hmac,
    })
  );
  check("and still nothing was written by any of those", (await countOf("products")) === productsBefore);
} else {
  console.log("  --    nothing imported to sign against");
}

console.log("\nand the three Shopify keeps for itself");
// These cannot have a per-store address: Shopify refuses to let an app
// subscribe to them and asks for one URI for every shop. So they read
// the shop from the SIGNED body instead of a header — forging that
// means holding the app secret. 0057 deleted the static route and left
// them with nowhere to land at all; shop/redact is the one that erases
// a merchant's data, so this is checked rather than assumed.
//
// shop/redact itself is deliberately never called here.
const MARK = `check-${Date.now().toString(36)}`;
const GHOST_EMAIL = `ghost-${Date.now().toString(36)}@example.com`;
const signed = (obj) => {
  // A marker only this check writes, so the sweep below removes what
  // it invented and never a real privacy request.
  const raw = JSON.stringify({ ...obj, warmluke_check: MARK });
  return [raw, createHmac("sha256", env.SHOPIFY_CLIENT_SECRET).update(raw).digest("base64")];
};
// The shapes Shopify actually sends. The list is what tells the two
// customer topics apart, and it is inside the signed body — so the
// topic header cannot be swapped for the other one.
const [raw, hmac] = signed({
  shop_domain: store.shop_domain,
  customer: { id: 424242 },
  orders_requested: [],
});
const [redactRaw, redactHmac] = signed({
  shop_domain: store.shop_domain,
  customer: { id: 424242 },
  orders_to_redact: [],
});
// A body carrying BOTH lists used to satisfy either branch, so the
// keys that were supposed to tell the topics apart only did so while
// the body behaved.
const [bothRaw, bothHmac] = signed({
  shop_domain: store.shop_domain,
  customer: { id: 424242 },
  orders_requested: [],
  orders_to_redact: [],
});

// Scoped to this store and to rows carrying this check's own marker.
// Deleting by customer id alone would have reached across every
// store and taken real requests with it — a data request is an
// obligation with a clock on it, not clutter.
const sweep = () =>
  admin
    .from("shopify_data_requests")
    .delete()
    .eq("store_id", store.id)
    // This run's marker, not merely "some marker": deleting every
    // marked row would take a concurrent or interrupted run's with it.
    .eq("payload->>warmluke_check", MARK);


try {
  const asked = await stranger.rpc("abo_shopify_compliance", {
    p_topic: "customers/data_request",
    p_raw: raw,
    p_hmac: hmac,
  });
  check("a signed compliance request is accepted", !asked.error);

  check(
    "an unsigned one is not",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/data_request",
      p_raw: raw,
      p_hmac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    })
  );

  // The app-wide door must not become a way round the per-store one.
  check(
    "and an ordinary topic cannot come through this door",
    await refused("abo_shopify_compliance", {
      p_topic: "products/update",
      p_raw: raw,
      p_hmac: hmac,
    })
  );

  // A body with no shop in it names nobody, and must not fall through
  // to some default store.
  const [anon_, anonHmac] = signed({ customer: { id: 1 } });
  check(
    "nor a body that names no shop",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/redact",
      p_raw: anon_,
      p_hmac: anonHmac,
    })
  );

  // And the tokenized door no longer claims to handle them: it returns
  // 0, the same as any topic nobody asked for, rather than acting.
  const atTheWrongDoor = await stranger.rpc("abo_shopify_webhook", {
    p_token: address,
    p_topic: "customers/redact",
    p_raw: raw,
    p_hmac: hmac,
  });
  check("the per-store door does not handle them", atTheWrongDoor.data === 0);

  // The topic is a header and the body is what Shopify signed. A real
  // data request replayed as shop/redact would have deleted the store
  // and everything hanging off it — so the destructive verb now has to
  // agree with the shape of the body it arrived with.
  const asRedact = await refused("abo_shopify_compliance", {
    p_topic: "shop/redact",
    p_raw: raw,
    p_hmac: hmac,
  });
  check("a customer payload cannot be replayed as shop/redact", asRedact);

  // And the two customer topics cannot wear each other's body either.
  // A data request read as a redaction would erase the customer it was
  // only supposed to ask about.
  check(
    "nor a data request replayed as a redaction",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/redact",
      p_raw: raw,
      p_hmac: hmac,
    })
  );
  check(
    "nor a redaction replayed as a data request",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/data_request",
      p_raw: redactRaw,
      p_hmac: redactHmac,
    })
  );

  // A customer who never had an account is named by email alone.
  // Asking for an id would have dropped a real request on the floor.
  const [byEmail, byEmailHmac] = signed({
    shop_domain: store.shop_domain,
    customer: { email: "someone@example.com" },
    orders_requested: [],
  });
  const emailOnly = await stranger.rpc("abo_shopify_compliance", {
    p_topic: "customers/data_request",
    p_raw: byEmail,
    p_hmac: byEmailHmac,
  });
  check("a customer known only by email is still heard", !emailOnly.error);

  // And a redaction for that customer has to actually delete them.
  // This accepted the request, passed a null id down, matched nothing,
  // deleted nothing — and answered 200. A legal obligation reported as
  // honoured and never carried out.
  const { data: ghost } = await admin
    .from("customers")
    .insert({
      store_id: store.id,
      external_id: `gid://shopify/Customer/ghost-${MARK}`,
      email: GHOST_EMAIL,
      name: "No account, still a person",
    })
    .select("id")
    .single();
  check("a customer with no account can exist", !!ghost);

  const [redactByEmail, redactByEmailHmac] = signed({
    shop_domain: store.shop_domain,
    customer: { email: GHOST_EMAIL },
    orders_to_redact: [],
  });
  const wiped = await stranger.rpc("abo_shopify_compliance", {
    p_topic: "customers/redact",
    p_raw: redactByEmail,
    p_hmac: redactByEmailHmac,
  });
  check("and a redaction by email says it removed one", wiped.data === 1);
  const stillThere = await admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("id", ghost?.id ?? "00000000-0000-0000-0000-000000000000");
  check("and they are really gone", stillThere.count === 0);

  // And they stay gone. The delete used to hold only until the next
  // import: Shopify keeps sending the person we were told to forget,
  // and the importer upserts whatever it is sent. A redaction undone
  // by the next sync is not a redaction.
  const { error: resurrect } = await admin.from("customers").insert({
    store_id: store.id,
    external_id: `gid://shopify/Customer/ghost-${MARK}`,
    email: GHOST_EMAIL,
    name: "Back again",
  });
  check("an import cannot bring them back", !resurrect);
  const returned = await admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store.id)
    .eq("email", GHOST_EMAIL);
  check("and the row really did not reappear", returned.count === 0);

  // A redaction by id must bury one person, not everybody who shares
  // their address. The mark used to carry the email too, and the
  // trigger matches on either field — so one request silently refused
  // every future write for a household, a shop@ inbox, or an address
  // Shopify reissued years later.
  const SHARED = `shared-${MARK}@example.com`;
  const named = `gid://shopify/Customer/named-${MARK}`;
  const bystander = `gid://shopify/Customer/bystander-${MARK}`;
  await admin.from("customers").insert([
    { store_id: store.id, external_id: named, email: SHARED, name: "The one named" },
    { store_id: store.id, external_id: bystander, email: SHARED, name: "Shares the address" },
  ]);
  const byId = await stranger.rpc("abo_shopify_compliance", {
    p_topic: "customers/redact",
    p_raw: signed({
      shop_domain: store.shop_domain,
      customer: { id: `named-${MARK}` },
      orders_to_redact: [],
    })[0],
    p_hmac: signed({
      shop_domain: store.shop_domain,
      customer: { id: `named-${MARK}` },
      orders_to_redact: [],
    })[1],
  });
  check("a redaction by id removes exactly one", byId.data === 1);
  const left = await admin
    .from("customers")
    .select("external_id")
    .eq("store_id", store.id)
    .eq("email", SHARED);
  check(
    "and the one who only shares the address stays",
    (left.data ?? []).length === 1 && left.data[0].external_id === bystander
  );
  // And that bystander can still be written to afterwards.
  const { error: stillWritable } = await admin
    .from("customers")
    .update({ name: "Still here" })
    .eq("store_id", store.id)
    .eq("external_id", bystander);
  const after = await admin
    .from("customers")
    .select("name")
    .eq("store_id", store.id)
    .eq("external_id", bystander)
    .maybeSingle();
  check(
    "and is not silently frozen by somebody else's redaction",
    !stillWritable && after.data?.name === "Still here"
  );
  await admin.from("customers").delete().eq("store_id", store.id).eq("email", SHARED);

  // A body wearing both lists belongs to neither topic.
  check(
    "a body carrying both lists is not a data request",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/data_request",
      p_raw: bothRaw,
      p_hmac: bothHmac,
    })
  );
  check(
    "nor a redaction",
    await refused("abo_shopify_compliance", {
      p_topic: "customers/redact",
      p_raw: bothRaw,
      p_hmac: bothHmac,
    })
  );

  // "customer": null is not a customer, and neither is a string.
  for (const [what, value] of [["null", null], ["a string", "banana"]]) {
    const [odd, oddHmac] = signed({
      shop_domain: store.shop_domain,
      customer: value,
      orders_requested: [],
    });
    check(
      `a customer that is ${what} is refused`,
      await refused("abo_shopify_compliance", {
        p_topic: "customers/data_request",
        p_raw: odd,
        p_hmac: oddHmac,
      })
    );
  }
  const survived = await admin
    .from("stores")
    .select("id", { count: "exact", head: true })
    .eq("id", store.id);
  check("and the store is still here", survived.count === 1);

} finally {
  // Whatever the asserts did, this runs: a made-up data request must
  // not outlive the check that invented it.
  // The tombstone and the person it names, both invented here.
  const sweptGhost = await admin
    .from("customers")
    .delete()
    .eq("store_id", store.id)
    .eq("email", GHOST_EMAIL);
  const sweptMark = await admin
    .from("shopify_redactions")
    .delete()
    .eq("store_id", store.id)
    .eq("email", GHOST_EMAIL);
  const sweptExt = await admin
    .from("shopify_redactions")
    .delete()
    .eq("store_id", store.id)
    .in("external_id", [
      `gid://shopify/Customer/ghost-${MARK}`,
      `gid://shopify/Customer/named-${MARK}`,
    ]);
  const sweptShared = await admin
    .from("customers")
    .delete()
    .eq("store_id", store.id)
    .eq("email", `shared-${MARK}@example.com`);
  check(
    "no redaction this check invented is left behind",
    !sweptGhost.error && !sweptMark.error && !sweptExt.error && !sweptShared.error
  );

  const swept = await sweep();
  const left = await admin
    .from("shopify_data_requests")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store.id)
    .eq("payload->>warmluke_check", MARK);
  // A cleanup that could not run is not a clean table. `(null ?? 0) === 0`
  // read as success whether the count was zero or the query had failed.
  check(
    "no data request this check invented is left behind",
    !swept.error && !left.error && left.count === 0
  );
}

console.log(fails.length === 0 ? "\nthe public key opens nothing" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
