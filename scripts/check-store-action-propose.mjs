// A change to the shop is asked for one way, whoever asks, and only asked.
//
// MCP's propose_store_action and Luke's tool both go through
// proposeStoreAction (src/lib/store-action-propose.ts). This holds each
// gate in the order it says no, that the sentence on the card comes from
// the change and not the assistant, that MCP carries no copy of the
// gates, and that Luke asking twice for the same change in one turn is
// one request. The database is stood in for: the feature switch, the
// scopes the store granted, and the propose call, which is recorded.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-action-propose.mjs

import { readFileSync } from "node:fs";
import { aiProposeTool, proposeStoreAction, readTargets } from "../src/lib/store-action-propose.ts";
import { MOST_TARGETS, STORE_ACTIONS, actionSpec } from "../src/lib/store-actions.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const proposed = [];
const db = ({ on = true, scopes = null, refuse = null } = {}) => ({
  rpc: async (name, args) => {
    // The owner's account switch, read for the project whoever asks (0195).
    if (name === "abo_store_actions_on") return { data: on, error: null };
    if (name === "abo_action_propose") {
      proposed.push(args);
      return refuse ? { data: null, error: { message: refuse } } : { data: `act-${proposed.length}`, error: null };
    }
    return { data: null, error: null };
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { granted_scopes: scopes } }) }) }) }),
});
const store = {
  id: "s1",
  project_id: "p1",
  shop_domain: "bishop.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  last_synced_at: null,
};
const order = "gid://shopify/Order/1001";
const tag = { action: "add_tags", targets: [{ id: order }], params: { tags: ["VIP"] } };

console.log("each gate says no in a sentence, before anything is asked");
const off = await proposeStoreAction(db({ on: false }), store, tag);
check("the account's switch is off: said so", !off.ok && /not turned on for this account/.test(off.answer.error));
const unknown = await proposeStoreAction(db(), store, { ...tag, action: "delete_everything" });
check(
  "a change the registry does not know: named, with what can be asked",
  !unknown.ok &&
    /no change called "delete_everything"/.test(unknown.answer.error) &&
    unknown.answer.what_can_be_asked_for.length > 0
);
const none = await proposeStoreAction(db(), store, { ...tag, action: "" });
check("no change named at all", !none.ok && none.answer.error === "Say which change to ask for.");
const loose = await proposeStoreAction(db(), store, { ...tag, targets: ["1001", { id: order }] });
check(
  "a target that is not Shopify's own id is named back",
  !loose.ok && /cannot be acted on/.test(loose.answer.error) && /"1001" is not a Shopify id/.test(loose.answer.these[0])
);
const many = await proposeStoreAction(db(), store, {
  ...tag,
  targets: Array.from({ length: MOST_TARGETS + 1 }, (_, i) => ({ id: `gid://shopify/Order/${i + 1}` })),
});
check(
  `more than ${MOST_TARGETS} at once is refused`,
  !many.ok && new RegExp(`${MOST_TARGETS + 1} things at once`).test(many.answer.error)
);
const noTag = await proposeStoreAction(db(), store, { ...tag, params: {} });
check(
  "what the change itself needs is checked: a tag with no tag",
  !noTag.ok && noTag.answer.error === "No tag was given."
);
const short = await proposeStoreAction(db({ scopes: ["read_orders"] }), store, tag);
check(
  "a store that has not allowed it: say which, and that it needs reconnecting",
  !short.ok && short.reconnect === true && /has not allowed Warmluke to write_orders/.test(short.answer.error)
);
check("and none of those asked for anything", proposed.length === 0);

console.log("\nasked, with the card's words written from the change");
const asked = await proposeStoreAction(
  db({ scopes: ["write_orders", "write_customers", "write_products"] }),
  store,
  tag
);
check("it is asked, once", asked.ok && proposed.length === 1 && asked.id === "act-1");
check(
  "the sentence comes from the change, not from the assistant",
  proposed[0].p_summary === actionSpec("add_tags").say([{ id: order }], { tags: ["VIP"] }) &&
    asked.summary === proposed[0].p_summary
);
check(
  "on this store, in this app, with what was named",
  proposed[0].p_store === "s1" && proposed[0].p_project === "p1" && proposed[0].p_targets[0].id === order
);
const dbSays = await proposeStoreAction(db({ refuse: "Not your project." }), store, tag);
check("and the database's own no is passed on", !dbSays.ok && dbSays.answer.error === "Not your project.");
check(
  "a bare id is lifted into a target",
  readTargets([order]).targets[0].id === order && readTargets([order]).wrong.length === 0
);

console.log("\nLuke's tool");
proposed.length = 0;
const heard = [];
const luke = aiProposeTool({ db: db(), store }, (a) => heard.push(a));
const first = await luke.execute(tag, { toolCallId: "t1", messages: [] });
const again = await luke.execute(tag, { toolCallId: "t2", messages: [] });
check(
  "the same change twice in a turn is one request",
  proposed.length === 1 && JSON.stringify(first) === JSON.stringify(again)
);
check("heard once, with the card's sentence", heard.length === 1 && heard[0].summary === proposed[0].p_summary);
check(
  "and tells the model it is waiting, not done",
  first.status === "waiting for the merchant" && /Never say it is done/.test(first.note)
);
const lukeOff = aiProposeTool({ db: db({ on: false }), store });
check(
  "with the switch off it answers the same no",
  /not turned on/.test((await lukeOff.execute(tag, { toolCallId: "t3", messages: [] })).error)
);

console.log("\nevery change can find what it aims at");
{
  const given = new Set(Object.values(STORE_TABLES).flatMap((t) => Object.keys(t.gives ?? {})));
  const needed = [...new Set(Object.values(STORE_ACTIONS).flatMap((a) => a.needs ?? []))];
  const missing = needed.filter((k) => !given.has(k));
  check("each kind a change aims at is handed out by some list the tools read", missing.length === 0);
  if (missing.length) console.log("     → nothing gives:", missing.join(", "));
}

console.log("\nMCP asks the same way");
{
  const route = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
  check("through the shared function", /proposeStoreAction\(db, store,/.test(route));
  check(
    "with no second copy of the gates",
    !route.includes("function readTargets") &&
      !route.includes("not turned on for this account") &&
      !route.includes('rpc("abo_action_propose"')
  );
}

console.log("\nput back: the opposite of what went through, built from the row, asked as any change is");
{
  // The database as it holds a change: the row, the store's grant, and
  // whether Warmluke's copy of the stock was read (it must not be, for an undo).
  const read = [];
  const held = (row) => ({
    ...db(),
    from: (table) => {
      read.push(table);
      const one = table === "store_actions" ? row : { granted_scopes: null, available: 9 };
      const chain = { eq: () => chain, maybeSingle: async () => ({ data: one }) };
      return { select: () => chain };
    },
  });
  const item = "gid://shopify/InventoryItem/7";
  const place = "gid://shopify/Location/1";
  const went = {
    store_id: "s1",
    action: "set_stock",
    status: "done",
    params: {},
    targets: [
      { id: item, locationId: place, quantity: 41, from: 5 },
      { id: "gid://shopify/InventoryItem/8", locationId: place, quantity: 2, from: 6 },
    ],
    outcome: { done: [item], errors: ["gid://shopify/InventoryItem/8: refused"] },
  };
  const before = proposed.length;
  const back = await proposeStoreAction(held(went), store, { undo_of: "act-9" });
  const asked = proposed[before];
  check(
    "a count goes back to what it was, from what it was set to",
    back.ok && asked?.p_action === "set_stock" && asked.p_targets[0].quantity === 5 && asked.p_targets[0].from === 41
  );
  check("only the lines that really changed", asked?.p_targets.length === 1);
  check("and the copy is not read again over what the change left", !read.includes("store_inventory"));
  const waiting = await proposeStoreAction(held({ ...went, status: "pending" }), store, { undo_of: "act-9" });
  check("a change that has not gone through is not put back", !waiting.ok && /went through/.test(waiting.answer.error));
  const elsewhere = await proposeStoreAction(held({ ...went, store_id: "s2" }), store, { undo_of: "act-9" });
  check("nor one made in another store", !elsewhere.ok && /another store/.test(elsewhere.answer.error));
  const note = await proposeStoreAction(held({ ...went, action: "set_order_note", params: { note: "x" } }), store, {
    undo_of: "act-9",
  });
  check(
    "nor one that cannot be, which says why",
    !note.ok && /does not keep what the note said/.test(note.answer.error)
  );
  const unseen = await proposeStoreAction(held(null), store, { undo_of: "act-9" });
  check("nor one the asker cannot see", !unseen.ok && /not one you can see/.test(unseen.answer.error));
  const offAgain = await proposeStoreAction({ ...held(went), ...db({ on: false }) }, store, { undo_of: "act-9" });
  check("and the account's switch still holds", !offAgain.ok && /not turned on/.test(offAgain.answer.error));
}

console.log("\nfields of one thing (7 Oct): each its own value, the merchant's hand for a price or a status");
{
  const asked0 = proposed.length;
  // The copy, as each view keeps it; store_actions for an undo.
  const shop = (copy, row = null) => ({
    ...db(),
    from: (table) => {
      const one = table === "store_actions" ? row : table === "stores" ? { granted_scopes: null } : copy;
      const chain = { eq: () => chain, limit: () => chain, maybeSingle: async () => ({ data: one }) };
      return { select: () => chain };
    },
  });
  const variant = "gid://shopify/ProductVariant/81001";
  const copy = { shopify_id: variant, price: 899, barcode: "", product_shopify_id: "gid://shopify/Product/80001" };
  const priced = { action: "update_variant", targets: [{ id: variant, set: { price: "499.50" } }] };
  const ai = await proposeStoreAction(shop(copy), store, priced);
  check(
    "Luke or their AI asking for a price: refused, and told where the merchant does it",
    !ai.ok && /typing it on the list/.test(ai.answer.error) && /never publish or reprice/.test(ai.answer.error)
  );
  const hand = await proposeStoreAction(shop(copy), store, priced, { byHand: true });
  const sent = proposed[proposed.length - 1];
  check(
    "the merchant's own typing goes, with what it was and the product it belongs to, from the copy",
    hand.ok && sent.p_targets[0].was.price === "899" && sent.p_targets[0].productId === "gid://shopify/Product/80001"
  );
  check("and the card says it from the change", /from "899" to "499.50"/.test(sent.p_summary));
  const barcode = await proposeStoreAction(shop(copy), store, {
    action: "update_variant",
    targets: [{ id: variant, set: { barcode: "890123" } }],
  });
  check("a barcode their AI may ask for", barcode.ok);
  const listed = (await import("../src/lib/store-action-propose.ts")).ACTION_CATALOGUE.find(
    (c) => c.action === "update_variant"
  );
  check(
    "and their AI is offered the barcode, never the price",
    "barcode" in listed.each_target_sets && !("price" in listed.each_target_sets)
  );
  const person = "gid://shopify/Customer/1";
  const badEmail = await proposeStoreAction(shop({ shopify_id: person, email: "" }), store, {
    action: "update_customer",
    targets: [{ id: person, set: { email: "not-an-email" } }],
  });
  check(
    "what cannot go in a field is said before anything is asked",
    !badEmail.ok && /not an email address/.test(badEmail.answer.error)
  );
  const unknownField = await proposeStoreAction(shop({ shopify_id: person }), store, {
    action: "update_customer",
    targets: [{ id: person, set: { total_spent: "5" } }],
  });
  check(
    "a field Shopify keeps for itself is named back",
    !unknownField.ok && /not something Warmluke changes/.test(unknownField.answer.error)
  );

  // Put back: only while the copy says what the change left (or, behind, what it replaced).
  const renamed = {
    store_id: "s1",
    action: "update_customer",
    status: "done",
    params: {},
    outcome: { done: [person], errors: [] },
    targets: [{ id: person, set: { name: "Aarav S" }, was: { name: "Aarav Sharma" } }],
  };
  const back = await proposeStoreAction(shop({ shopify_id: person, name: "Aarav S" }, renamed), store, {
    undo_of: "act-1",
  });
  const undone = proposed[proposed.length - 1];
  check(
    "a name goes back to what it was",
    back.ok && undone.p_targets[0].set.name === "Aarav Sharma" && undone.p_targets[0].was.name === "Aarav S"
  );
  const behind = await proposeStoreAction(shop({ shopify_id: person, name: "Aarav Sharma" }, renamed), store, {
    undo_of: "act-1",
  });
  check("a copy not caught up yet still lets it go back", behind.ok);
  const moved = await proposeStoreAction(shop({ shopify_id: person, name: "Aarav Kumar" }, renamed), store, {
    undo_of: "act-1",
  });
  check(
    "one changed again since is refused, not written over",
    !moved.ok && /changed again since/.test(moved.answer.error)
  );
  const repriced = {
    store_id: "s1",
    action: "update_variant",
    status: "done",
    params: {},
    outcome: { done: [variant], errors: [] },
    targets: [
      { id: variant, productId: "gid://shopify/Product/80001", set: { price: "499.50" }, was: { price: "899" } },
    ],
  };
  const aiBack = await proposeStoreAction(shop({ ...copy, price: 499.5 }, repriced), store, { undo_of: "act-2" });
  check(
    "and their AI cannot put a price back either: that is repricing too",
    !aiBack.ok && /typing it on the list/.test(aiBack.answer.error)
  );
  check("nothing was asked for beyond the ones that went", proposed.length - asked0 === 4);
}

console.log(
  fails.length === 0 ? "\na change to the shop is asked one way, and only asked" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
