// ─────────────────────────────────────────────────────────────
// The one place that says what this platform can do.
//
// The vocabulary used to live in three places that could drift: the
// TypeScript types, the hand-written prompt, and the hand-written
// validators. A hand-written prompt can advertise something the
// validator never checks and the renderer never draws — which is
// exactly how the assistant ended up promising capabilities that did
// not exist.
//
// Now the prompt text and the validation rules are generated from the
// same declarations below. Anything absent here is something the
// assistant is never told about AND that validation rejects, so the
// two can no longer disagree.
//
// One seam remains and cannot be closed from here: the expression
// evaluator in Postgres (migration 0010) is a separate implementation.
// `scripts/check-operator-parity.mjs` asserts the two agree.
// ─────────────────────────────────────────────────────────────

export interface OperatorSpec {
  /** [min, max] argument count. */
  arity: [number, number];
  /** One line the assistant reads. */
  doc: string;
  group: "logic" | "compare" | "presence" | "maths";
  /**
   * Needs the rest of the section to evaluate, so it only works inside
   * an automation, where Postgres runs it. A button guard or a stat is
   * evaluated in the browser against one row and cannot answer it.
   */
  serverOnly?: boolean;
}

export const OPERATORS = {
  and: { arity: [1, 20], doc: "every argument is true", group: "logic" },
  or: { arity: [1, 20], doc: "any argument is true", group: "logic" },
  not: { arity: [1, 1], doc: "the argument is false", group: "logic" },
  if: {
    arity: [2, 3],
    doc: "args are test, then, else — pick a value from a condition. Use it so a flag clears itself when the condition stops being true, instead of setting it once and leaving it on",
    group: "logic",
  },

  "=": { arity: [2, 2], doc: "equal", group: "compare" },
  "!=": { arity: [2, 2], doc: "not equal", group: "compare" },
  ">": { arity: [2, 2], doc: "greater than", group: "compare" },
  ">=": { arity: [2, 2], doc: "greater than or equal", group: "compare" },
  "<": { arity: [2, 2], doc: "less than", group: "compare" },
  "<=": { arity: [2, 2], doc: "less than or equal", group: "compare" },
  contains: { arity: [2, 2], doc: "text contains text, ignoring case", group: "compare" },
  starts_with: { arity: [2, 2], doc: "text starts with text", group: "compare" },

  is_empty: { arity: [1, 1], doc: "the value is blank", group: "presence" },
  is_set: { arity: [1, 1], doc: "the value is filled in", group: "presence" },
  changed: { arity: [1, 1], doc: "this field just changed; takes a { field } leaf", group: "presence" },

  "+": { arity: [2, 20], doc: "add", group: "maths" },
  "-": { arity: [2, 20], doc: "subtract", group: "maths" },
  "*": { arity: [2, 20], doc: "multiply", group: "maths" },
  "/": { arity: [2, 20], doc: "divide", group: "maths" },
  concat: { arity: [1, 20], doc: "join values into one piece of text", group: "maths" },
  round: { arity: [1, 1], doc: "round to a whole number", group: "maths" },
  today: { arity: [0, 0], doc: "today's date", group: "maths" },
  now: { arity: [0, 0], doc: "the current timestamp", group: "maths" },
  days_since: {
    arity: [1, 1],
    doc: "whole days from a date up to today — NEGATIVE for dates in the future. Use it for ageing ('sat 3 days'), never for countdowns: 'days_since <= 7' is true for every future date, however far off",
    group: "maths",
  },
  sum_matching: {
    arity: [2, 7],
    doc: 'the first arg, read from each OTHER row of this section, added up over the rows that match — matched exactly as count_matching matches them. `sum_matching(qty, item, place, status != "Released")` is how many are already held of this item at this place',
    group: "maths",
    serverOnly: true,
  },
  store_value: {
    arity: [4, 8],
    doc: 'one field of one of this project\'s store rows, found by its keys: store_value("inventory_levels", "available", "inventory_item_id", item, "location_id", place) is what can be sold of that item there. The list, the field and each key are { "const": … } names from the store\'s own lists; each key\'s value is an expression (a { field } of this row). Null when no such row is in the store',
    group: "maths",
    serverOnly: true,
  },
  count_matching: {
    arity: [1, 6],
    doc: 'how many OTHER rows in this section match. A { field } arg means the sibling must share this row\'s value for it; an operator arg is a test run against the sibling, where { field } reads the SIBLING\'s value. So `count_matching(order_id, verified != "Complete")` is "how many of this order\'s other lines are still unverified" — `= 0` on the row being finished means it was the last one. Use `> 0` with fields alone to catch a duplicate or a clash',
    group: "compare",
    serverOnly: true,
  },
} as const satisfies Record<string, OperatorSpec>;

export type ExprOp = keyof typeof OPERATORS;
export const EXPR_OPS = Object.keys(OPERATORS) as ExprOp[];

export function isOperator(op: unknown): op is ExprOp {
  return typeof op === "string" && op in OPERATORS;
}

export function isServerOnly(op: ExprOp): boolean {
  return "serverOnly" in OPERATORS[op] && OPERATORS[op].serverOnly === true;
}

// ── Columns ──────────────────────────────────────────────────

export const COLUMNS = {
  text: "a short piece of free text",
  longtext: "notes — several lines, shown in full when the row is opened",
  number: "a plain number",
  currency: "an amount of money",
  percent: "a percentage, stored as the number (15 means 15%)",
  date: "a calendar date (YYYY-MM-DD)",
  time: "a time of day (HH:MM)",
  boolean: "yes or no",
  badge: "a short status word, shown as a coloured pill",
  dropdown: "one of a fixed set of choices",
  phone: "a phone number — tap to call",
  email: "an email address — tap to write",
  url: "a link to a page",
  // Stores the id of a row in another section, so the two stay one
  // thing instead of two copies that drift. Needs "linkTo" naming that
  // section.
  link: "a link to a row in another section — pick it from a list instead of retyping it",
  // Only for a field an actual scanner reads into. Ordinary reference
  // codes are `text`: marking them barcode invites a scan workflow the
  // owner never asked for.
  barcode: "a code read by a barcode scanner",
} as const;

export type ColumnType = keyof typeof COLUMNS;
export const COLUMN_TYPES = Object.keys(COLUMNS) as ColumnType[];

// ── Views ────────────────────────────────────────────────────

export interface ViewSpecDoc {
  doc: string;
  /** Extra keys the view needs, and the column types each accepts. */
  fields: Record<string, { types?: ColumnType[]; required: boolean }>;
}

export const VIEWS = {
  table: { doc: "rows and columns, for comparing many fields side by side", fields: {} },
  board: {
    doc: "one column per stage, for work that moves through stages",
    fields: {
      groupBy: { types: ["badge", "dropdown", "text", "boolean"], required: true },
      cardTitle: { required: true },
      cardFields: { required: false },
    },
  },
  calendar: {
    doc: "a month grid, for anything tied to a day",
    fields: {
      dateField: { types: ["date"], required: true },
      titleField: { required: true },
      colorBy: { types: ["badge", "dropdown", "text", "boolean"], required: false },
    },
  },
  cards: {
    doc: "tiles, for browsing a catalogue",
    fields: {
      titleField: { required: true },
      subtitleField: { required: false },
      badgeField: { required: false },
      fields: { required: false },
    },
  },
  list: {
    doc: "one line per row, for a queue or checklist",
    fields: {
      titleField: { required: true },
      secondaryField: { required: false },
      badgeField: { required: false },
      metaField: { required: false },
    },
  },
  custom: {
    doc: "a screen you write, HTML with a script, for a flow or a look none of the views above draws (see CUSTOM VIEW)",
    fields: { title: { required: true }, html: { required: true } },
  },
} as const satisfies Record<string, ViewSpecDoc>;

export type ViewType = keyof typeof VIEWS;
export const VIEW_TYPES = Object.keys(VIEWS) as ViewType[];

// ── Automation triggers ──────────────────────────────────────
// The last vocabulary that lived only in hand-written prompt text and
// a hardcoded list in the validator. "schedule" was barely mentioned,
// so the assistant rarely reached for it — and a rule that notices
// without being asked is the whole reason automations exist.

/** When a schedule runs, said once for every place Luke is told about schedules. */
export const SCHEDULE_TIMING =
  'A rule with code chooses its own times (it returns next, below). A rule without code runs on the store\'s clock: "at": "07:00" is the time (daily, weekly, monthly); "on": ["mon", "sat"] the days of the week (daily or weekly; weekly needs it); monthly takes "date", 1 to 31 (past a month\'s end, its last day). "Roz subah", "every Monday", "on the 1st" are these, not an interval: say the time you chose. A rule with a time first runs at the next one, never at once. Without them it runs an interval after its last run';

export const TRIGGERS = {
  record_created: "a row is added",
  record_updated: "a row is changed",
  schedule: `nobody touched anything — re-checks every row on its own. This is the only way to catch things that go quiet: an unpaid invoice, a job nobody moved, a follow-up never made. Needs "every": hourly, daily, weekly or monthly, and its "when" picks which rows to act on. ${SCHEDULE_TIMING}`,
  store_row_added:
    "a new row came in from the store — a new order, a new customer — the moment it arrives. Only on a section over the store, for a rule's own code (run_code) or an alert",
  before_save:
    "a row is ABOUT to be saved, and its rule may stop it: a \"when\" that is true refuses the save with the rule's own sentence (action refuse), and nothing is written. The database judges it in the same moment as the save, one save at a time for that rule, so two people saving at once can never both get the last unit, the same slot or the same claim; it holds for every way a row is written — the app, a screen, a rule, their own AI. Its only action is refuse. It does not stop Shopify, a till or another app changing the store's own figures",
} as const;

export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

// ── Automation actions ───────────────────────────────────────

export const AUTOMATION_ACTIONS = {
  set_fields: "write fields on the row that fired, or on matching rows in another section",
  create_record:
    "add a row to another section, filling its fields from this one. This is how work moves between sections without the owner retyping it: an order that gets refused opens a return, a job marked done raises an invoice, a delivery that fails becomes a callback. Whenever two sections describe the same thing at different stages, the second one should be created by a rule, not by hand — typed twice means the two drift apart",
  run_code:
    "run a function you write, for logic the expressions cannot say — a slab rate, a table to look up, a sum across sections, a calendar. It is handed the row and the rows it reads, and returns the fields to set (see CODE RULE)",
  refuse:
    'stop the save and show { "message": "…" }, one sentence in the owner\'s language saying what to do instead ("Only what is left can be held — release a hold first"). Only on a before_save rule, and alone',
  alert:
    'tell the owner, in the app\'s bell and on the Overview: { "title": "Big COD order", "show": ["order_number", "total"], "severity": "attention" or "critical" }. The title is a few words in the owner\'s language; "show" is up to four fields of the row, as they read on it. One alert a row: a row added or changed tells once and stays until put away; store_row_added tells the moment the store brings the row in; a schedule keeps it open while the row matches and closes it once it does not. In the app only — never email, SMS or WhatsApp',
} as const;

export type AutomationActionType = keyof typeof AUTOMATION_ACTIONS;
export const AUTOMATION_ACTION_TYPES = Object.keys(AUTOMATION_ACTIONS) as AutomationActionType[];

// ── Aggregations ─────────────────────────────────────────────

export const STAT_OPS = {
  count: "how many rows",
  sum: "add the value across rows",
  avg: "average of the value",
  min: "smallest value",
  max: "largest value",
} as const;

export type StatOp = keyof typeof STAT_OPS;
export const STAT_OP_LIST = Object.keys(STAT_OPS) as StatOp[];

// ── Things people ask for that this platform genuinely cannot do ──
// Stated once, here, so the assistant never has to describe the
// platform in its own words. The UI renders these; the model only
// ever repeats what the OWNER asked for.

export const NOT_SUPPORTED: Array<{ id: string; label: string }> = [
  { id: "public_pages", label: "pages your customers can visit without logging in" },
  { id: "payments", label: "taking payments, carts or checkout" },
  { id: "messaging", label: "sending email, SMS or WhatsApp" },
  { id: "files", label: "photos, files or attachments" },
  {
    id: "external_sync",
    label:
      "keeping another system or website in step with this one (single changes to your own Shopify store can be asked for in the chat)",
  },
  // Badge colours come from the value itself, so every vocabulary gets
  // stable distinct colours without a lookup table. The trade is that
  // a specific colour cannot be chosen.
  // The assistant builds the app; the owner owns the data in it. Asked
  // to change a value it produced a plan that inserted a duplicate row
  // and called it an update.
  { id: "remove_field", label: "removing a field once a section has it — you can rename or reorder, not delete" },
  { id: "edit_data", label: "changing what's in a row — open the row and edit it yourself, it's quicker" },
  { id: "custom_colours", label: "choosing the colour of a status — colours are picked automatically" },
];

// ── Prompt generation ────────────────────────────────────────

function bullets(entries: Array<[string, string]>): string {
  return entries.map(([k, v]) => `  ${k} — ${v}`).join("\n");
}

/**
 * The vocabulary section of the system prompt, built from the same
 * declarations validation uses. Editing a capability here changes what
 * the assistant is told and what is accepted, together.
 */
export function vocabularyPrompt(): string {
  const opsByGroup = (group: OperatorSpec["group"]) =>
    EXPR_OPS.filter((o) => OPERATORS[o].group === group && !isServerOnly(o))
      .map((o) => `${o} (${OPERATORS[o].doc})`)
      .join(", ");

  const serverOnly = EXPR_OPS.filter(isServerOnly)
    .map((o) => `  ${o} — ${OPERATORS[o].doc}`)
    .join("\n");

  const viewLines = VIEW_TYPES.map((v) => {
    const spec = VIEWS[v];
    const keys = Object.entries(spec.fields)
      .map(([k, f]) => {
        const types = "types" in f && f.types ? ` [${(f.types as string[]).join("/")}]` : "";
        return `${k}${f.required ? "" : "?"}${types}`;
      })
      .join(", ");
    return `  ${v} — ${spec.doc}${keys ? `. Keys: ${keys}` : ""}`;
  }).join("\n");

  return `WHAT THIS PLATFORM CAN DO — this list is exhaustive. Anything not here does not exist, and a plan that uses it is rejected.

COLUMN TYPES:
${bullets(COLUMN_TYPES.map((c) => [c, COLUMNS[c]]))}

VIEWS:
${viewLines}

EXPRESSION OPERATORS (used for automation triggers, row-action guards, stat values and stat filters):
  logic:    ${opsByGroup("logic")}
  compare:  ${opsByGroup("compare")}
  presence: ${opsByGroup("presence")}
  maths:    ${opsByGroup("maths")}

AUTOMATION-ONLY OPERATORS (allowed in an automation trigger; NOT in a button guard, stat or scan action, which see only one row):
${serverOnly}

AUTOMATION TRIGGERS:
${bullets(TRIGGER_TYPES.map((t) => [t, TRIGGERS[t]]))}

AUTOMATION ACTIONS:
${bullets(AUTOMATION_ACTION_TYPES.map((a) => [a, AUTOMATION_ACTIONS[a]]))}

STAT AGGREGATIONS:
${bullets(STAT_OP_LIST.map((s) => [s, STAT_OPS[s]]))}
  A stat runs over EVERY row of the section, not the page on screen. "where" may use today / days_since, so a fixed "last 30 days revenue" is sum of total where days_since(placed_at) <= 30. A window they want to pick or change (15, 30, 60 days, their own dates) is the section's period instead, and then no stat counts days itself.
  "by" — group the rows by a field and show the top few, as a list in the card: "Sales by city" is { "op": "sum", "value": { "field": "total" }, "by": "city", "limit": 5 }. "Orders per customer" is op count, by customer_name. Use it whenever they ask "by", "per", "which X most".

NOT POSSIBLE ON THIS PLATFORM — never design around these, never describe a workaround for them:
${NOT_SUPPORTED.map((n) => `  - ${n.label}`).join("\n")}`;
}

/**
 * What Luke can build, in one breath: for the talk road, whose answers
 * about the product may say no more than this. The design road is
 * given the whole vocabulary above.
 */
export function capabilitySummary(): string {
  const on = TRIGGER_TYPES.filter((t) => t !== "schedule").map((t) => t.replace("record_", ""));
  const does = AUTOMATION_ACTION_TYPES.map((a) => a.replace(/_/g, " "));
  return `WHAT LUKE CAN BUILD — say no more than this about the platform, in these words:
- Sections of rows with typed fields (${COLUMN_TYPES.join(", ")}), shown as a ${VIEW_TYPES.join(", ")}.
- Search, filters, stat cards, a choice of dates (the last N days, their own dates, all), more views of a section as tabs (a written screen beside its table), sorting, one-tap row buttons, and a barcode scan bar.
- A screen written for their own flow when none of the views above draws it, and a rule's own code for logic the expressions cannot say.
- Rules that run when a row is ${on.join(" or ")}, or on a schedule, and then ${does.join(" or ")}.
- Sections over the connected store's own lists (orders, products, customers, stock and the rest), with the owner's fields kept beside each row.
NOT POSSIBLE — never promise these, never describe a workaround: ${NOT_SUPPORTED.map((n) => n.label).join("; ")}.`;
}
