// Every change Warmluke can make, held to the same rules.
//
// The point of a registry is that the fifth entry costs what the
// first did. That only holds if something walks it: otherwise entry
// five arrives with no undo, a read scope, a mutation that forgets
// to ask for userErrors, and nothing says so until a merchant's shop
// is the thing that notices.
//
// So this iterates STORE_ACTIONS rather than naming actions. Adding
// one means adding a line of sample data below — the check refuses
// to pass an action it has no example for, which is the cheapest way
// to make "add an entry" also mean "say what it does".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-action-registry.mjs

import { readFileSync, readdirSync } from "node:fs";
import {
  ACTIONS,
  ACTION_SCOPES,
  MOST_TARGETS,
  NEVER_DOES,
  STORE_ACTIONS,
  actionSpec,
  actionsFor,
  editsFor,
  sendNowSaid,
  targetFrom,
  whatCanChange,
  whatNeverChanges,
} from "../src/lib/store-actions.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** One believable call per action. A new action with none fails below. */
const SAMPLES = {
  add_tags: {
    targets: [{ id: "gid://shopify/Order/1" }, { id: "gid://shopify/Order/2" }],
    params: { tags: ["rush"] },
  },
  remove_tags: {
    targets: [{ id: "gid://shopify/Order/1" }],
    params: { tags: ["rush"] },
  },
  set_order_note: {
    targets: [{ id: "gid://shopify/Order/1" }],
    params: { note: "Customer asked for delivery after 6pm" },
  },
  set_stock: {
    // As the server keeps it: with the count it changes from.
    targets: [{ id: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", quantity: 40, from: 12 }],
    params: {},
  },
  // Changes of fields (7 Oct): what each sets, and what the copy said it was.
  update_customer: {
    targets: [
      {
        id: "gid://shopify/Customer/1",
        set: { name: "Aarav S", email: "aarav@shop.in" },
        was: { name: "Aarav Sharma", email: "" },
      },
    ],
    params: {},
  },
  update_product: {
    targets: [{ id: "gid://shopify/Product/1", set: { status: "DRAFT" }, was: { status: "ACTIVE" } }],
    params: {},
  },
  update_variant: {
    targets: [
      {
        id: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        set: { price: "499.50" },
        was: { price: "899" },
      },
    ],
    params: {},
  },
  update_item: {
    targets: [
      { id: "gid://shopify/InventoryItem/1", set: { sku: "SS-1", cost: "" }, was: { sku: "SS-111", cost: "420" } },
    ],
    params: {},
  },
};

console.log("every action has an example to be checked against");
for (const name of ACTIONS) check(`${name}`, !!SAMPLES[name]);
check(
  "and no example names an action nobody declared",
  Object.keys(SAMPLES).every((k) => !!actionSpec(k))
);

for (const name of ACTIONS) {
  const spec = STORE_ACTIONS[name];
  const sample = SAMPLES[name];
  if (!sample) continue;
  console.log(`\n${name}`);

  check("it is called something", typeof spec.label === "string" && spec.label.length > 2);
  check("it belongs to a connector", spec.connector === "shopify");
  check("it says how sure the merchant must be", spec.confirm === "list" || spec.confirm === "typed");

  // A read scope here is the mistake worth catching: it would pass
  // every test in a read-only app and do nothing in a real one.
  check("it asks only for write scopes", spec.scopes.length > 0 && spec.scopes.every((s) => s.startsWith("write_")));

  const said = spec.say(sample.targets, sample.params);
  check("it can be said in a sentence", typeof said === "string" && said.length > 10);
  check("and the sentence counts what it touches", /\b\d+\b|\bone\b/.test(said));

  check("nothing to do is refused", typeof spec.check([], sample.params) === "string");
  check("and a real one is allowed", spec.check(sample.targets, sample.params) === null);

  check("the mutation is a mutation", /^\s*mutation\s/.test(spec.mutation));
  // Without userErrors Shopify's refusals come back as a success
  // with nothing in it, and the action is recorded as done.
  check("and it asks for userErrors", /userErrors\s*{[^}]*message/.test(spec.mutation));

  const vars = spec.variables(sample.targets[0], sample.params, { key: "an-attempt-key" });
  check("one call names the thing it changes", JSON.stringify(vars).includes(sample.targets[0].id));
  // Every $variable the mutation declares is one it is handed: a mutation
  // that takes an idempotency key and is never given one is refused by
  // Shopify on every call, which is how set_stock stood on 2026-07.
  const declared = [...(spec.mutation.split("{")[0].matchAll(/\$([A-Za-z]+)\s*:/g) ?? [])].map((m) => m[1]);
  check(
    "every variable the mutation declares is given",
    declared.length > 0 && declared.every((d) => vars[d] !== undefined)
  );

  check(
    "a refusal is found in the answer",
    spec.errors({ data: { x: { userErrors: [{ message: "no" }] } } }).length === 1
  );
  check("and a clean answer has none", spec.errors({ data: { x: { node: { id: "1" } } } }).length === 0);

  if (spec.undo) {
    const back = spec.undo(sample.targets, sample.params);
    check("its undo names a real action", !!actionSpec(back.action));
    // Itself only when it sets each line back to what it was (a stock count).
    check(
      "and is not itself, unless it sets the lines back",
      back.action !== name || JSON.stringify(back.targets) !== JSON.stringify(sample.targets)
    );
    const other = actionSpec(back.action);
    const again = other?.undo?.(back.targets, back.params);
    check("and that one undoes it in turn", again?.action === name);
    check(
      "back where it began",
      JSON.stringify(again?.targets.map((t) => [t.id, t.quantity])) ===
        JSON.stringify(sample.targets.map((t) => [t.id, t.quantity]))
    );
  } else {
    check("no undo, and it says why", typeof spec.undoNote === "string" && spec.undoNote.length > 20);
  }
}

console.log("\nand the registry adds up");
check(
  "every scope is a write scope",
  ACTION_SCOPES.every((s) => s.startsWith("write_"))
);
check("and each is listed once", new Set(ACTION_SCOPES).size === ACTION_SCOPES.length);
check("an unknown action has no spec", actionSpec("delete_everything") === null);
check("and there is a ceiling on how much one change touches", MOST_TARGETS > 0 && MOST_TARGETS <= 500);

// ── And something has to be able to aim it ──────────────────────
//
// An assistant asks for a change it can aim, and it aims with ids it
// read somewhere. set_stock was declared, correct, checked and
// impossible to call for a day: setting a count takes an inventory
// item and a location, and the stock list handed back a product, a
// variant and four numbers. Nothing was broken and nothing could
// happen.
//
// So the two halves are declared and matched here: an action says
// which kinds of id its targets carry, a list says which kinds its
// rows give, and an action nobody can aim fails this.
console.log("\nand every id an action needs, some list gives");
{
  const given = new Map();
  for (const [table, spec] of Object.entries(STORE_TABLES)) {
    for (const [kind, column] of Object.entries(spec.gives ?? {})) {
      check(`${table} names a column for ${kind}`, typeof column === "string" && column.length > 0);
      if (!given.has(kind)) given.set(kind, []);
      given.get(kind).push({ table, column, view: spec.view });
    }
  }

  for (const name of ACTIONS) {
    const spec = STORE_ACTIONS[name];
    check(`${name} says what it aims at`, Array.isArray(spec.needs));
    for (const kind of spec.needs) {
      // Tags take any taggable id, and the lists that carry those
      // already hand back external_id. What must not pass is a kind
      // that appears in no list at all.
      const from = given.get(kind);
      const fromExternal = ["Order", "Product", "Customer"].includes(kind);
      check(`${name}: a ${kind} id can be read from somewhere`, (from && from.length > 0) || fromExternal);
    }
  }

  // And the column really is in the view. The declaration is in
  // TypeScript and the view is in SQL, so this is the one place they
  // are held against each other.
  const migrations = readdirSync(new URL("../supabase/migrations", import.meta.url)).sort();
  const newestDefining = (view) =>
    migrations
      .filter((f) =>
        readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8").includes(
          `create or replace view public.${view} `
        )
      )
      .pop();
  for (const [kind, where] of given) {
    for (const { table, column, view } of where) {
      const file = newestDefining(view);
      check(`${view} is defined by a migration`, !!file);
      if (!file) continue;
      const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
      check(`${view} really selects ${column} (${table} → ${kind})`, new RegExp(`\\b${column}\\b`).test(sql));
    }
  }
}

// ── And what the pages promise is what the registry holds ────────
//
// The connect box said "we never write to it" for days after the app
// could. Nothing failed, because nothing held the sentence to the
// code. Now the sentences come off the registry, and this holds both
// halves: what it says it can do is every action there is, and what
// it says it never does is no action there is.
console.log("\nand what the pages promise is what the registry holds");
{
  // Said briefly (7 Oct): each change by its few words, a change of fields by its noun.
  const can = whatCanChange();
  const details = /change the details of .*/.exec(can)?.[0] ?? "";
  for (const name of ACTIONS) {
    const spec = STORE_ACTIONS[name];
    if (spec.connector !== "shopify") continue;
    const label = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
    check(
      `what it can change names ${name}`,
      spec.ask.kind === "fields" ? details.includes(`${spec.ask.noun}s`) : can.includes(spec.brief ?? label)
    );
  }

  // Never, by anyone: no change does it. Only by the merchant's hand (a price,
  // a status): every field that does it is marked so, and Luke and their AI are told never.
  const never = whatNeverChanges();
  const aiNever = whatNeverChanges("ai");
  for (const { say, stem, byHand } of NEVER_DOES) {
    check(`what Luke and their AI never do says "${say}"`, aiNever.includes(say));
    check(`and what nobody does ${byHand ? "leaves out" : "says"} "${say}"`, never.includes(say) === !byHand);
    for (const name of ACTIONS) {
      const spec = STORE_ACTIONS[name];
      const said = `${name} ${spec.label} ${spec.mutation}`.toLowerCase();
      const fields = spec.ask.kind === "fields" ? spec.ask.fields : {};
      if (!byHand) check(`${name} does not ${say}`, !said.includes(stem));
      else
        check(
          `${name} lets only the merchant ${say}`,
          byHand.every((f) => !fields[f] || fields[f].byHand === true) &&
            (!said.includes(stem) || byHand.some((f) => fields[f]?.byHand))
        );
    }
  }

  // Every page that makes the promise makes it from here.
  const SURFACES = {
    "src/components/ConnectShopify.tsx": ["whatCanChange"],
    "src/app/page.tsx": ["whatCanChange", "whatNeverChanges"],
    "src/app/terms/page.tsx": ["whatCanChange", "whatNeverChanges"],
    // What a connected AI is told on connecting, from the guide (lib/client-guide), and the route still never claims otherwise.
    "src/lib/client-guide.ts": ["whatCanChange", "whatNeverChanges"],
    "src/app/api/mcp/route.ts": [],
  };
  for (const [file, uses] of Object.entries(SURFACES)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const fn of uses) check(`${file} says it with ${fn}()`, src.includes(`${fn}(`));
    // Comments may quote the old line to say why it went; copy may not.
    const copy = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    check(`${file} no longer says it never writes`, !/never write/i.test(copy));
    check(`${file} no longer calls the store read-only`, !/store data is read-only/i.test(copy));
  }
}

console.log("\nand a list's own screen offers what its rows can be aimed at (0195)");
{
  for (const name of ACTIONS) {
    const spec = STORE_ACTIONS[name];
    const aimed = Object.values(spec.aims ?? {}).flat();
    check(`${name} aims only at kinds it needs`, aimed.length > 0 && aimed.every((k) => spec.needs.includes(k)));
    check(
      `${name} says what is typed for it`,
      !!spec.ask && ["tags", "text", "count", "fields"].includes(spec.ask.kind)
    );
  }
  const offered = (t) => actionsFor(STORE_TABLES[t]?.gives).join();
  check("orders: a tag on and off, and a note", offered("orders") === "add_tags,remove_tags,set_order_note");
  check("stock: its count, and its item's SKU", offered("inventory_levels") === "set_stock,update_item");
  check("customers: their details", offered("customers").includes("update_customer"));
  check(
    "variants: a price or barcode, and an item's SKU or cost",
    offered("variants") === "update_variant,update_item"
  );
  check("a list with no Shopify id of its own: nothing", offered("fulfillments") === "");
  const stock = targetFrom(STORE_ACTIONS.set_stock, STORE_TABLES.inventory_levels.gives, {
    inventory_item_id: "gid://shopify/InventoryItem/1",
    location_id: "gid://shopify/Location/2",
  });
  check(
    "a stock row aims at its item and its place",
    stock?.id === "gid://shopify/InventoryItem/1" && stock?.locationId === "gid://shopify/Location/2"
  );
  check(
    "a row without its id is not aimed",
    targetFrom(STORE_ACTIONS.add_tags, STORE_TABLES.orders.gives, {}) === null
  );
  check(
    "what the owner agrees to is said from the change",
    /without asking you again/.test(sendNowSaid(STORE_ACTIONS.set_stock, "x.myshopify.com"))
  );
  // Edit mode: a column is typed into only where a change writes it whole,
  // or both adds to it and takes from it; read from the registry, not listed.
  const editable = (t) =>
    editsFor(
      STORE_TABLES[t]?.gives,
      STORE_TABLES[t].columns.map((c) => c.field)
    );
  check(
    "stock: its available count is set, and its SKU",
    JSON.stringify(editable("inventory_levels")) === '{"available":{"set":"set_stock"},"sku":{"set":"update_item"}}'
  );
  check("customers: name, email and phone", Object.keys(editable("customers")).join() === "name,email,phone");
  check(
    "orders: their tags",
    JSON.stringify(editable("orders")) === '{"tags":{"add":"add_tags","remove":"remove_tags"}}'
  );
  check(
    "a column is set by one change on a list, never two",
    ["orders", "customers", "products", "inventory_levels", "variants"].every((t) =>
      Object.values(editable(t)).every((e) => (e.set ? !e.add && !e.remove : e.add && e.remove))
    )
  );
  check(
    "a list of words is edited by adding and taking",
    JSON.stringify(editsFor(STORE_TABLES.orders.gives, ["tags"])) ===
      '{"tags":{"add":"add_tags","remove":"remove_tags"}}'
  );
  check(
    "a column the list does not show is not edited",
    Object.keys(editsFor(STORE_TABLES.orders.gives, [])).length === 0
  );
  for (const [name, spec] of Object.entries(STORE_ACTIONS))
    if (spec.edits) check(`${name} edits as set, add or remove`, ["set", "add", "remove"].includes(spec.edits.as));

  // Undo (7 Oct): a count goes back to what it was, from what this change left,
  // so Shopify refuses it if anything moved the count since.
  const back = STORE_ACTIONS.set_stock.undo(
    [
      { id: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/2", quantity: 41, from: 5 },
      { id: "gid://shopify/InventoryItem/3", locationId: "gid://shopify/Location/2", quantity: 7 },
    ],
    {}
  );
  check(
    "a stock count is put back to what it was, from what it was set to",
    back.action === "set_stock" &&
      back.targets.length === 1 &&
      back.targets[0].quantity === 5 &&
      back.targets[0].from === 41
  );
  check("a line with no count it changed from is not put back", !back.targets.some((t) => t.id.endsWith("/3")));
  check(
    "a tag added is taken off, and one taken off is added",
    STORE_ACTIONS.add_tags.undo([], { tags: ["x"] }).action === "remove_tags" &&
      STORE_ACTIONS.remove_tags.undo([], { tags: ["x"] }).action === "add_tags"
  );
  check(
    "a note, with nothing kept of the old one, says why it cannot be",
    !STORE_ACTIONS.set_order_note.undo && !!STORE_ACTIONS.set_order_note.undoNote
  );
}

console.log(fails.length === 0 ? "\nthe fifth entry will cost what the first did" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
