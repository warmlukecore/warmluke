// Setting a stock count, as Shopify's 2026-07 API takes it.
//
// The action was written for an older version: ignoreCompareQuantity: true,
// no changeFromQuantity, no @idempotent. On 2026-07 the first no longer
// exists, the second is required on every line, and so is the third (since
// 2026-04), so every stock change would have been refused. And had it gone
// through, a count that moved in Shopify meanwhile would have been written
// over, and a retry after a dropped answer could have applied it twice.
//
// So: the count a line changes FROM is the server's, read from Warmluke's
// copy when it is asked for; Shopify refuses the change if its own count
// has moved since; and each line of one approved change carries one key,
// however often it is sent.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-set-stock.mjs

import { actionSpec } from "../src/lib/store-actions.ts";
import { attemptKey } from "../src/lib/run-action.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const spec = actionSpec("set_stock");
const line = {
  id: "gid://shopify/InventoryItem/544713708014",
  locationId: "gid://shopify/Location/109716570413",
  quantity: 3,
};

console.log("the mutation, as 2026-07 takes it");
check("it names the idempotency key", /@idempotent\(key: \$idempotencyKey\)/.test(spec.mutation));
check("and declares it", /\$idempotencyKey: String!/.test(spec.mutation));
check(
  "it no longer sends ignoreCompareQuantity",
  !/ignoreCompareQuantity/.test(spec.mutation + JSON.stringify(spec.variables({ ...line, from: 5 }, {}, { key: "k" })))
);
check("it asks for the error code", /userErrors \{[^}]*code/.test(spec.mutation));

console.log("\neach line says what it changes from");
const v = spec.variables({ ...line, from: 5 }, {}, { key: "k1" });
const q = v.input.quantities[0];
check("the count it changes from goes to Shopify", q.changeFromQuantity === 5);
check("and the new one", q.quantity === 3 && q.inventoryItemId === line.id && q.locationId === line.locationId);
check("the key rides with it", v.idempotencyKey === "k1");
check(
  "a line without a count to compare still sends the field, as null",
  spec.variables(line, {}, { key: "k" }).input.quantities[0].changeFromQuantity === null
);

console.log("\none key per line of one change, however often it is sent");
const a = attemptKey("11111111-2222-3333-4444-555555555555", 0);
check("the same line gets the same key", a === attemptKey("11111111-2222-3333-4444-555555555555", 0));
check("another line gets another", a !== attemptKey("11111111-2222-3333-4444-555555555555", 1));
check("another change gets another", a !== attemptKey("99999999-2222-3333-4444-555555555555", 0));
check(
  "it is UUID-shaped, as Shopify recommends",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a)
);

console.log("\nthe count it changes from is the server's");
// A stand-in for the caller's client, reading Warmluke's copy of the stock.
const copy = (rows) => ({
  from: (view) => {
    const eq = {};
    const q2 = {
      select: () => q2,
      eq: (k, val) => ((eq[k] = val), q2),
      maybeSingle: async () => ({
        data:
          view === "store_inventory"
            ? (rows.find(
                (r) =>
                  r.store_id === eq.store_id &&
                  r.inventory_item_id === eq.inventory_item_id &&
                  r.location_id === eq.location_id
              ) ?? null)
            : null,
      }),
    };
    return q2;
  },
});
const db = copy([{ store_id: "s1", inventory_item_id: line.id, location_id: line.locationId, available: 7 }]);
const got = await spec.prepare(db, "s1", [{ ...line, from: 999 }]);
check("a count the caller sent is replaced by the copy's", !("error" in got) && got.targets[0].from === 7);
check("and the card says both", /from 7 to 3/.test(spec.say(got.targets, {})));
const missing = await spec.prepare(db, "s1", [{ ...line, locationId: "gid://shopify/Location/1" }]);
check(
  "an item not in the copy at that location is refused, not guessed",
  "error" in missing && /nothing was asked/i.test(missing.error)
);
const otherStore = await spec.prepare(db, "s2", [line]);
check("and another store's copy is never read for this one", "error" in otherStore);

console.log("\na count that moved in Shopify is not written over");
const stale = spec.errors({
  inventorySetQuantities: {
    inventoryAdjustmentGroup: null,
    userErrors: [
      {
        field: ["input", "quantities", "0", "changeFromQuantity"],
        message: "The specified compare quantity is stale.",
        code: "CHANGE_FROM_QUANTITY_STALE",
      },
    ],
  },
});
check("Shopify's refusal is said plainly", stale.length === 1 && /nothing was changed/i.test(stale[0]));
check(
  "other refusals still come through as Shopify said them",
  spec.errors({ x: { userErrors: [{ message: "Location not found", code: "NOT_FOUND" }] } })[0] === "Location not found"
);
check(
  "and a clean answer is no error",
  spec.errors({ inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: "now" }, userErrors: [] } }).length ===
    0
);

console.log(fails.length === 0 ? "\nstock is set once, from the count that was seen" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
