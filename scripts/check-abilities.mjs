// What Luke is told the platform does, against what it does.
//
// Asked for stock holds, Luke said three things that were not true of
// this platform: that stock rows carry no item or location id (every row
// has both; Luke was shown the columns a section displays, while the tool
// beside it returned the keys), that it could not write stock back to
// Shopify (it can, from the chat, with the owner's yes), and that Shopify
// changes show only after a sync (they arrive in seconds). And it said a
// fourth that WAS true — a rule cannot stop the second person taking the
// last unit — which the prompt never said, so the next design could just
// as well have offered flagging as if it were stopping.
//
// Each was a gap in what Luke is told. This holds what it is told to the
// registries the platform runs on, so the next list, key, action or limit
// reaches the prompt without anyone rewriting it, and a stale line fails
// here.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-abilities.mjs

import { readFileSync } from "node:fs";
import { STORE_TABLES, storeRowFields, storeKeys } from "../src/lib/store-read.ts";
import { abilitiesPrompt, isLive, keysByList } from "../src/lib/abilities.ts";
import { STORE_ACTIONS } from "../src/lib/store-actions.ts";
import { NOT_SUPPORTED } from "../src/lib/capabilities.ts";
import { buildSystemPrompt, buildTalkPrompt, validatePlan } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const STORE = {
  store_id: "s1",
  shop_domain: "check.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  country: "IN",
  importing: false,
  counts: { inventory_levels: 605, orders: 40 },
  values: {},
  snapshot: { last_synced_at: null, top_customers: [], best_sellers: [], recent: [], low: [] },
};
const [contract, project] = buildSystemPrompt([], "Check", "en-IN", "INR", STORE);
const design = `${contract}\n${project}`;
const talk = buildTalkPrompt([], "Check", "en-IN", "INR", STORE).join("\n");

console.log("identifiers a row has, beside the columns a section shows");
const shown = STORE_TABLES.inventory_levels.columns.map((c) => c.field);
check(
  "stock's display columns leave the ids out (the case itself)",
  !shown.includes("location_id") && !shown.includes("inventory_item_id")
);
check(
  "but a stock row's fields include them",
  ["inventory_item_id", "location_id"].every((k) => storeRowFields("inventory_levels").includes(k))
);
check(
  "and so do its keys",
  ["inventory_item_id", "location_id"].every((k) => storeKeys("inventory_levels").includes(k))
);
check(
  "every list's keys are in its fields",
  Object.keys(STORE_TABLES).every((t) => storeKeys(t).every((k) => storeRowFields(t).includes(k)))
);
check("Luke is told stock's keys", /inventory_levels: [^;]*inventory_item_id[^;]*location_id/.test(design));
check("and told to match on keys, never on a name", /never by a name, a title or a SKU/.test(design));
check(
  "a missing column is not a missing field, and null is not unknown",
  /a field missing from a section's columns is not a field missing from the data/.test(design) &&
    /one empty lookup is not proof/.test(design)
);

// The validator reads the same fields: a computed column over the stock's
// location id was refused as a field that does not exist.
const overStock = {
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: {
    name: "stock-by-place",
    nav_label: "Stock by place",
    icon: "box",
    parent_id: null,
    source_table: "inventory_levels",
  },
  newSchema: { columns: [{ field: "place_ref", label: "Place", type: "text", compute: { field: "location_id" } }] },
  newRecords: null,
  explanation: "Stock with where it is kept.",
};
const v = validatePlan(overStock, [], null, null);
check(
  "the validator takes a computed column over a stock row's location id",
  v.ok || !v.errors.some((e) => /location_id/.test(e))
);
if (!v.ok) console.log(`     errors were: ${v.errors.join(" | ")}`);

console.log("\nwhat is live, from what Shopify is asked to send");
check("stock updates within seconds (it has webhooks)", isLive("inventory_levels"));
check("payouts do not (none)", !isLive("payouts"));
check(
  "Luke is told which",
  /update within seconds of a change in Shopify \([^)]*inventory_levels/.test(design) &&
    /payouts only when the store is read again/.test(design)
);
check("and that a Shopify change does not fire a rule", /does not fire a rule/.test(design));
check("the old 'not seen the moment it happens' is gone", !/not seen the moment it happens/.test(design));

console.log("\nchanging the shop: which changes, where, and with what");
for (const spec of Object.values(STORE_ACTIONS)) {
  const said = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
  check(`Luke knows it can ${said}`, design.includes(said) && talk.includes(said));
}
check(
  "only from the chat, with the owner's yes",
  /Only as a request made in this chat, one card per change, that the owner agrees to/.test(design)
);
check(
  "never from a rule, a button, a scan or a screen",
  /cannot be started by a rule, a button, a scan or a screen/.test(design)
);
check("with the permissions it needs named", design.includes("write_inventory"));
check(
  "and 'not possible' no longer reads as 'cannot change Shopify'",
  !!NOT_SUPPORTED.find((n) => n.id === "external_sync")?.label.includes(
    "single changes to your own Shopify store can be asked for"
  )
);

console.log("\nthe limits, said as plainly as the abilities");
check("an after-save rule is seeing it, not stopping it", /flagging is seeing it, not stopping it/.test(design));
check(
  "a before_save rule refuses, one save at a time",
  /A before_save rule runs BEFORE the save and refuses it/.test(design) &&
    /one save at a time for that rule/.test(design)
);
check("and says what it cannot guard: Shopify's own stock", /a hold in Warmluke is a hold in Warmluke/.test(design));
check(
  "Luke is shown how to stop the second one",
  /STOPPING, NOT FLAGGING/.test(design) && /"type": "before_save"/.test(design) && /"type": "refuse"/.test(design)
);
check("flagging is never offered as stopping", /never offer flagging as if it were stopping/i.test(design));
check(
  "a row knows which login added and changed it, never a typed name",
  /Every row records the login that added it and the login that last changed it/.test(design) &&
    /never what anybody types or sends/.test(design)
);
check("and what a rule cannot yet do with it is said", /A rule does not yet choose by who is saving/.test(design));
check(
  "history is kept, and nobody can change it",
  /Every add, change and removal of a row is kept/.test(design) && /nobody can change it/.test(design)
);
check("a screen is sealed off", /It cannot reach Shopify, the internet/.test(design));
check("available is not reduced twice", /Never take committed off it again/.test(design));
check("the talk road is told the same", talk.includes(abilitiesPrompt()));

console.log("\nno stale line left saying otherwise");
check(
  "a team is not in the NOT POSSIBLE examples any more",
  !/NOT POSSIBLE list — several people using it/.test(design)
);
check(
  "Luke knows the owner can add people",
  /The owner can add people; each sees the sections shared with them/.test(design)
);
check("unmet says why", /Not in your data: \/ Only from this chat: \/ Not in Warmluke yet:/.test(design));
check(
  "keys are listed only where a list has Shopify's own",
  keysByList().every((k) => k.keys.some((f) => f !== "id"))
);

console.log("\na repair sees what the lookups returned");
{
  // A repair has no tools. It had only its own rejected reply to go on,
  // so a design refused for naming a field could not look again.
  const { foundBlock } = await import("../src/lib/engine.ts");
  check("nothing looked up, nothing added (a repair reads as it did)", foundBlock([]) === "");
  const one = foundBlock([
    {
      about: "Looked up stock for SKU CAB-1",
      result: {
        rows: [
          { sku: "CAB-1", inventory_item_id: "gid://shopify/InventoryItem/1", location_id: "gid://shopify/Location/2" },
        ],
      },
    },
  ]);
  check(
    "the rows come back with every field they carried",
    one.includes("inventory_item_id") && one.includes("location_id")
  );
  const big = foundBlock(
    Array.from({ length: 50 }, (_, i) => ({ about: `lookup ${i}`, result: { rows: "x".repeat(900) } }))
  );
  check("and it is cut to size, saying so", big.length <= 12_200 && big.includes("cut to fit"));
}

console.log("\nan outside AI reads the same");
const route = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
check("design_format hands it what runs where", /what_runs_where: abilitiesPrompt\(\)/.test(route));

console.log(
  fails.length === 0 ? "\nLuke is told what the platform does, no more and no less" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
