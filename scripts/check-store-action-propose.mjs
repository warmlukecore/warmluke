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
    if (name === "abo_feature") return { data: on, error: null };
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

console.log(
  fails.length === 0 ? "\na change to the shop is asked one way, and only asked" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
