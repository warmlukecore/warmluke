// What a design is allowed to say about a section it has not read.
//
// A client wrote a low-stock design by hand, was rejected eight times
// over the spelling of one key, and the ninth attempt — the one that
// was accepted — put the words "Filter by undefined" on the merchant's
// approval card and would have half-built when approved.
//
// Three separate holes let that through, and each one is checked here:
//
//   the submitted schema for a store-backed section was replaced with
//   the store's and nothing was said, so a column the design depended
//   on vanished between acceptance and apply;
//
//   field checks passed whenever the caller had no schema to check
//   against, and the MCP route never had one, so no field a client
//   named was ever verified;
//
//   a filter's label was never looked at, and the renderer prints it.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-design.mjs

import { parseReply, PLAN_FORMAT, WORKED_EXAMPLE } from "../src/lib/ai.ts";
import { storeTableSchema } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const MOD = "11111111-1111-1111-1111-111111111111";
const modules = [
  {
    id: MOD,
    project_id: "p",
    parent_id: null,
    name: "jobs",
    nav_label: "Jobs",
    icon: "table",
    route: "/jobs",
    sort_order: 1,
    source_table: null,
    created_at: "2026-01-01",
  },
];
const jobsSchema = {
  columns: [
    { field: "customer", label: "Customer", type: "text" },
    { field: "stage", label: "Stage", type: "badge" },
  ],
};
const schemas = (id) => (id === MOD ? jobsSchema : null);

const run = (plans, lookup) => parseReply(JSON.stringify({ plans }), modules, null, null, lookup);

// ── The design that was actually accepted ────────────────────
console.log("the design that got through");
{
  const got = run(
    [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: {
          name: "low-stock-alerts",
          nav_label: "Low Stock",
          icon: "package",
          source_table: "inventory_levels",
        },
        newSchema: {
          columns: [{ field: "alert_status", label: "Alert Status", type: "dropdown", options: ["Low Stock", "OK"] }],
        },
        features: { filters: [{ field: "alert_status", options: ["Low Stock", "OK"] }] },
        explanation: "Flags stock that is running out.",
      },
    ],
    schemas
  );
  // Once refused, because the column was lost on the way in and the
  // rule after it wrote to nothing. Now a field of theirs sits beside
  // each stock row (0128) and is kept; the one thing left wrong here is
  // the filter's missing label. (A flag worked out from "available" is
  // still the better shape, and the next case builds it that way.)
  const said = (got.errors ?? []).join(" | ");
  check("a field of theirs beside the store's stock is kept", !/not one of them/.test(said));
  check("and what is left to fix is only the filter's label", !got.ok && got.errors.every((e) => /label/.test(e)));
  if (fails.length) console.log(`     errors were: ${said}`);
}

// ── The same request, written the way it can be built ────────
console.log("\nthe same request, done with a stat");
{
  const got = run(
    [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: {
          name: "low-stock",
          nav_label: "Low stock",
          icon: "package",
          source_table: "inventory_levels",
        },
        newSchema: null,
        features: {
          view: { type: "table" },
          stats: [
            {
              label: "At or below 5",
              op: "count",
              where: { op: "<=", args: [{ field: "available" }, { const: 5 }] },
            },
          ],
          defaultSort: { field: "available", dir: "asc" },
        },
        newRecords: null,
        explanation: "Your Shopify stock, lowest first, with a count of what is down to 5 or fewer.",
      },
    ],
    schemas
  );
  check("it is accepted", got.ok === true);
  if (!got.ok) console.log(`     errors were: ${got.errors.join(" | ")}`);
  else {
    const plan = got.reply.plans[0];
    // Filled in, not replaced: the design said nothing about columns, so
    // taking the store's is the only reading of it.
    check(
      "and it is given the store's own columns",
      plan.newSchema?.columns?.some((c) => c.field === "available")
    );
  }
}

// ── A field nobody checked ───────────────────────────────────
console.log("\na feature naming a column that isn't there");
{
  const plans = [
    {
      changeType: "FEATURE_UPDATE",
      targetModuleId: MOD,
      features: { filters: [{ field: "not_a_column", label: "Nope", options: ["a", "b"] }] },
      explanation: "Adds a filter.",
    },
  ];
  check("with the schema to hand, it is refused", !run(plans, schemas).ok);
  // The hole itself: no schema used to mean no checking, and the MCP
  // route passed no schema for anything.
  const blind = run(plans, undefined);
  check("and with no schema at all it is still refused", !blind.ok);
  check("saying so rather than passing", /No current schema found/.test((blind.errors ?? []).join(" ")));
}

// ── The label the renderer prints ────────────────────────────
console.log("\na filter with no label");
{
  const got = run(
    [
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: MOD,
        features: { filters: [{ field: "stage", options: ["Intake", "Done"] }] },
        explanation: "Adds a filter.",
      },
    ],
    schemas
  );
  check("is refused before it can print 'Filter by undefined'", !got.ok);
  check("needs a label", /needs a label/.test((got.errors ?? []).join(" ")));
}

// ── What design_format now answers with ──────────────────────
console.log("\nwhat a client is told the shape is");
{
  check('the operator key is shown as "op"', /"op": "\*"/.test(PLAN_FORMAT));
  check(
    '"view" is shown inside "features"',
    PLAN_FORMAT.indexOf('"features": {') < PLAN_FORMAT.indexOf('"view": { "type": "board"')
  );
  check("a filter is shown with its label", /"filters": \[ \{ "field": "stage", "label": "Stage"/.test(PLAN_FORMAT));
  // The prose it replaced said "filters, search, sorting, stats — see
  // the vocabulary", which is what left the key name to guesswork.
  check("and it is a shape, not a description of one", PLAN_FORMAT.includes('"args"'));

  // A grammar and a worked example are not the same thing, and an
  // example that would be rejected on arrival is worse than none.
  const example = run(structuredClone(WORKED_EXAMPLE.plans), schemas);
  check("the example handed out with it actually validates", example.ok === true);
  if (!example.ok) console.log(`     errors were: ${example.errors.join(" | ")}`);
}

// ── The eight rejections, replayed ───────────────────────────
//
// The loop was not the client being slow. Each attempt changed one key
// name because nothing had ever told it which name was right.
console.log("\nthe spellings that cost eight submissions");
{
  // "operator" instead of "op", and one action written singular. Both
  // have exactly one reading, so neither is an error any more.
  const got = run(
    [
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: MOD,
        automation: {
          name: "Flag done",
          definition: {
            trigger: { type: "record_updated" },
            action: {
              type: "set_fields",
              target: { self: true },
              set: {
                stage: {
                  operator: "if",
                  args: [
                    { operator: "=", args: [{ field: "stage" }, { const: "Done" }] },
                    { const: "Done" },
                    { const: "Open" },
                  ],
                },
              },
            },
          },
        },
        explanation: "Marks a job done when its stage says so.",
      },
    ],
    schemas
  );
  check('"operator" is read as "op" rather than rejected', got.ok === true);
  if (!got.ok) console.log(`     errors were: ${got.errors.join(" | ")}`);

  // And where a guess genuinely cannot be resolved, the message has to
  // carry the answer instead of only the complaint.
  const blind = run(
    [
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: MOD,
        automation: {
          name: "Flag done",
          definition: {
            trigger: { type: "record_updated" },
            actions: [
              // No target at all — the action is abandoned here, so the
              // second one carries the broken expression.
              { type: "set_fields", set: { stage: { const: "Done" } } },
              { type: "set_fields", target: { self: true }, set: { stage: { type: "=", args: [] } } },
            ],
          },
        },
        explanation: "Marks a job done when its stage says so.",
      },
    ],
    schemas
  );
  const said = (blind.errors ?? []).join(" | ");
  check("a missing target is told what to write", /"self": true/.test(said));
  check('a missing "op" is told the key is called op', /missing its "op"/.test(said));
}

console.log("\nwhen a plan points at nothing");
{
  const got = run(
    [
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: "self",
        features: { search: { enabled: true } },
        explanation: "Adds a search box.",
      },
    ],
    schemas
  );
  const said = (got.errors ?? []).join(" | ");
  check("the sections that do exist are named", said.includes(MOD) && /jobs/.test(said));
}

// ── What the merchant actually asked for ─────────────────────
console.log("\nflagging the store's own rows, without storing the flag");
{
  const lowStock = {
    op: "if",
    args: [{ op: "<=", args: [{ field: "available" }, { const: 5 }] }, { const: "Low" }, { const: "OK" }],
  };
  const got = run(
    [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: {
          name: "stock",
          nav_label: "Stock",
          icon: "package",
          source_table: "inventory_levels",
        },
        newSchema: {
          columns: [{ field: "stock_level", label: "Stock", type: "badge", compute: lowStock }],
        },
        features: {
          view: { type: "table" },
          filters: [{ field: "stock_level", label: "Stock", options: ["Low", "OK"] }],
          defaultSort: { field: "available", dir: "asc" },
        },
        newRecords: null,
        explanation: "Your Shopify stock, with each line marked Low or OK.",
      },
    ],
    schemas
  );
  check("a computed column on the store's rows is accepted", got.ok === true);
  if (!got.ok) console.log(`     errors were: ${got.errors.join(" | ")}`);
  else {
    const cols = got.reply.plans[0].newSchema.columns;
    check(
      "the store's own columns are still there",
      cols.some((c) => c.field === "available")
    );
    check(
      "and the computed one is kept beside them",
      cols.some((c) => c.field === "stock_level")
    );
  }
}

console.log("\nand nothing is allowed to write to one");
{
  const plans = (extra) => [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: "jobs2", nav_label: "Jobs 2", icon: "table", source_table: null },
      newSchema: {
        columns: [
          { field: "hours", label: "Hours", type: "number" },
          {
            field: "size",
            label: "Size",
            type: "badge",
            compute: {
              op: "if",
              args: [{ op: ">", args: [{ field: "hours" }, { const: 8 }] }, { const: "Big" }, { const: "Small" }],
            },
          },
        ],
      },
      features: extra,
      explanation: "Jobs, marked big or small by how long they take.",
    },
  ];

  check(
    "reading it is fine",
    run(plans({ filters: [{ field: "size", label: "Size", options: ["Big", "Small"] }] }), schemas).ok === true
  );

  const written = run(plans({ actions: [{ label: "Force big", set: { size: { const: "Big" } } }] }), schemas);
  check("a button that sets it is refused", !written.ok);
  check("and told why the write would vanish", /thrown away/.test((written.errors ?? []).join(" ")));
}

console.log("\nand a rule cannot read one either");
{
  // Rules run in Postgres against the stored row. A computed column is
  // worked out in the browser, so a rule reading it would compare
  // against blank while the screen shows a value — visible and wrong.
  const got = run(
    [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "jobs4", nav_label: "Jobs 4", icon: "table", source_table: null },
        newSchema: {
          columns: [
            { field: "hours", label: "Hours", type: "number" },
            { field: "note", label: "Note", type: "text" },
            {
              field: "size",
              label: "Size",
              type: "badge",
              compute: {
                op: "if",
                args: [{ op: ">", args: [{ field: "hours" }, { const: 8 }] }, { const: "Big" }, { const: "Small" }],
              },
            },
          ],
        },
        explanation: "Jobs, marked big or small by how long they take.",
      },
      {
        changeType: "AUTOMATION_ADD",
        targetModuleId: "#jobs4",
        automation: {
          name: "Note the big ones",
          definition: {
            trigger: {
              type: "record_updated",
              when: { op: "=", args: [{ field: "size" }, { const: "Big" }] },
            },
            actions: [{ type: "set_fields", target: { self: true }, set: { note: { const: "Long job" } } }],
          },
        },
        explanation: "Writes a note on the long jobs.",
      },
    ],
    schemas
  );
  check("it is refused", !got.ok);
  check("and told the rule would only ever see it blank", /always see it as blank/.test((got.errors ?? []).join(" ")));
}

console.log("\nand a compute cannot read a column below it");
{
  const got = run(
    [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: "jobs3", nav_label: "Jobs 3", icon: "table", source_table: null },
        newSchema: {
          columns: [
            { field: "a", label: "A", type: "text", compute: { field: "b" } },
            { field: "b", label: "B", type: "text", compute: { const: "x" } },
          ],
        },
        explanation: "Two computed columns, the wrong way round.",
      },
    ],
    schemas
  );
  // Rows are filled in top to bottom, so this would always read blank.
  check("it is refused rather than silently reading blank", !got.ok);
}

// ── A section over the store keeps the store's shape ─────────
// The prompt said a typed column cannot be stored on one; the validator
// let it through, and "Delivery Partner" on Orders passed every gate.
// Now it can (0128): a field of the merchant's sits beside each row,
// where no import reaches. What still cannot be written is the store's
// own fields, and a list whose rows have no id of their own keeps none.
console.log("\na section over the store keeps the store's shape, and the merchant's fields beside it");
{
  const ORD = "22222222-2222-2222-2222-222222222222";
  const RSN = "33333333-3333-3333-3333-333333333333";
  const mods = [
    ...modules,
    { ...modules[0], id: ORD, name: "orders", nav_label: "Orders", route: "/orders", source_table: "orders" },
    {
      ...modules[0],
      id: RSN,
      name: "reasons",
      nav_label: "Reasons",
      route: "/reasons",
      source_table: "return_reasons",
    },
  ];
  const ordersSchema = storeTableSchema("orders");
  const reasonsSchema = storeTableSchema("return_reasons");
  const look = (id) => (id === ORD ? ordersSchema : id === RSN ? reasonsSchema : schemas(id));
  const on = (id, cols, col) => ({
    changeType: "FIELD_ADD",
    targetModuleId: id,
    newSchema: { columns: [...cols, col] },
    explanation: "One more column on the list.",
  });
  const parse = (plans) => parseReply(JSON.stringify({ plans }), mods, null, null, look);
  const partner = { field: "delivery_partner", label: "Delivery Partner", type: "text" };
  check("a field of theirs is kept beside each order", parse([on(ORD, ordersSchema.columns, partner)]).ok);
  const grouped = parse([on(RSN, reasonsSchema.columns, partner)]);
  check(
    "but not beside a row with no id of its own, and told what to do instead",
    !grouped.ok && grouped.errors.some((e) => /COMPUTED/.test(e))
  );
  const computed = parse([
    on(ORD, ordersSchema.columns, {
      field: "big",
      label: "Big order",
      type: "boolean",
      compute: { op: ">=", args: [{ field: "total" }, { const: 5000 }] },
    }),
  ]);
  check("a computed column is welcome", computed.ok);

  // A new section over the orders, with what packing needs beside them.
  const packing = (over = {}) => ({
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: { name: "packing", nav_label: "Packing", icon: "table", source_table: "orders" },
    newSchema: { columns: [{ field: "packed", label: "Packed", type: "boolean" }] },
    features: {
      actions: [{ label: "Mark packed", set: { packed: { const: true } } }],
      scanMode: { lookupField: "order_number", action: { label: "Pack", set: { packed: { const: true } } } },
    },
    newRecords: null,
    explanation: "The store's orders, with a packed tick beside each.",
    ...over,
  });
  const built = parse([packing()]);
  check("a section over the orders takes a field of theirs, a button and a scan", built.ok);
  const cols = built.ok ? built.reply.plans[0].newSchema.columns.map((c) => c.field) : [];
  check(
    "and shows the store's columns first, theirs after",
    cols.slice(0, ordersSchema.columns.length).join() === ordersSchema.columns.map((c) => c.field).join() &&
      cols.at(-1) === "packed"
  );
  const setsTheirs = parse([
    packing({ features: { actions: [{ label: "Mark paid", set: { status: { const: "paid" } } }] } }),
  ]);
  check(
    "a button may not set a field of the store's",
    !setsTheirs.ok && setsTheirs.errors.some((e) => /"status"/.test(e) && /Shopify/.test(e))
  );
  const seeded = parse([packing({ newRecords: [{ packed: true }] })]);
  check("nor is it seeded with rows", !seeded.ok);
  check(
    "nor seeded later",
    !parse([
      { changeType: "RECORD_SEED", targetModuleId: ORD, newRecords: [{ order_number: "#1" }], explanation: "Rows." },
    ]).ok
  );

  // A rule on it sees the fields beside each row, not the store's.
  const withPacked = {
    columns: [
      ...ordersSchema.columns,
      { field: "packed", label: "Packed", type: "boolean" },
      { field: "packed_on", label: "Packed on", type: "date" },
    ],
  };
  const lookPacked = (id) => (id === ORD ? withPacked : look(id));
  const rule = (definition) =>
    parseReply(
      JSON.stringify({
        plans: [
          {
            changeType: "AUTOMATION_ADD",
            targetModuleId: ORD,
            automation: { name: "stamp", definition },
            explanation: "Stamp the day it was packed.",
          },
        ],
      }),
      mods,
      null,
      null,
      lookPacked
    );
  const stamp = { type: "set_fields", target: { self: true }, set: { packed_on: { op: "today", args: [] } } };
  const whenPacked = { op: "=", args: [{ field: "packed" }, { const: true }] };
  check(
    "a rule on a change of theirs is fine",
    rule({ trigger: { type: "record_updated", when: whenPacked }, actions: [stamp] }).ok
  );
  const readsStore = rule({
    trigger: { type: "record_updated", when: { op: ">", args: [{ field: "total" }, { const: 5000 }] } },
    actions: [stamp],
  });
  check(
    "one reading the store's fields is refused, saying why",
    !readsStore.ok && readsStore.errors.some((e) => /"total"/.test(e) && /Shopify/.test(e))
  );
  const writesStore = rule({
    trigger: { type: "record_updated", when: whenPacked },
    actions: [{ type: "set_fields", target: { self: true }, set: { status: { const: "packed" } } }],
  });
  check("one writing them is refused", !writesStore.ok && writesStore.errors.some((e) => /"status"/.test(e)));
  check(
    "a rule on a row being added is refused: nobody adds the store's rows here",
    !rule({ trigger: { type: "record_created" }, actions: [stamp] }).ok
  );
  check(
    "and a scheduled one: it would see only the rows somebody has touched",
    !rule({ trigger: { type: "schedule", every: "daily" }, actions: [stamp] }).ok
  );
  const intoStore = parseReply(
    JSON.stringify({
      plans: [
        {
          changeType: "AUTOMATION_ADD",
          targetModuleId: MOD,
          automation: {
            name: "copy",
            definition: {
              trigger: { type: "record_created" },
              actions: [{ type: "create_record", module_id: ORD, data: { order_number: { field: "customer" } } }],
            },
          },
          explanation: "Add an order for each job.",
        },
      ],
    }),
    mods,
    null,
    null,
    lookPacked
  );
  check("a rule elsewhere may not add rows to the store's list", !intoStore.ok);

  const own = parseReply(
    JSON.stringify({
      plans: [
        {
          changeType: "FIELD_ADD",
          targetModuleId: MOD,
          newSchema: { columns: [...jobsSchema.columns, { field: "note", label: "Note", type: "text" }] },
          explanation: "A note on each job.",
        },
      ],
    }),
    modules,
    null,
    null,
    schemas
  );
  check("and a section of their own still takes a typed field", own.ok);
}

// ── A design that says it has already happened ───────────────
//
// The sentence at the top of the approval card is the model's own,
// and on the MCP road it is what the merchant's assistant reads back
// to them word for word. One pending request said "I have removed
// the duplicate Product-2 section" while the section was still
// there, waiting for a confirmation nobody had given. The prompt now
// asks for the future tense; this is the half that does not depend
// on the model reading it.
console.log("\na design that claims to have happened already");
{
  const good = { field: "note", label: "Note", type: "text" };
  const one = (message) =>
    parseReply(
      JSON.stringify({
        type: "plans",
        message,
        plans: [
          {
            changeType: "FIELD_ADD",
            targetModuleId: MOD,
            newSchema: { columns: [...jobsSchema.columns, good] },
            explanation: "A note on each job.",
          },
        ],
      }),
      modules,
      null,
      null,
      schemas
    );
  const refused = (m) => {
    const r = one(m);
    return !r.ok && r.errors.some((e) => /already happened/.test(e));
  };
  // Both of the real ones, from production.
  check(
    '"I have removed the duplicate Product-2 section" is refused',
    refused("I have removed the duplicate Product-2 section and updated Products.")
  );
  check(
    '"I have added the section Off Check" is refused',
    refused("I have added the section Off Check with a single text field.")
  );
  check('and "I made the change you asked for"', refused("I made the change you asked for."));
  check('and "I\u2019ve updated Products"', refused("I\u2019ve updated Products with a status filter."));
  // And the sentences that must still get through. A validator that
  // fails these is one the model cannot satisfy.
  check("a future-tense line passes", one("This adds a note field to Jobs.").ok);
  check("so does a participle", one("Adding a Checked By field to Jobs.").ok);
  check(
    "so does amending the design, which really did happen",
    one("I have updated the design with your correction.").ok
  );
  check('so does "I have two options here"', one("I have two options here; this is the simpler one.").ok);
  check("and a sentence about their rows, not our work", one("Shows every order that has been paid.").ok);
}

console.log(fails.length === 0 ? "\na design says what it means" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
