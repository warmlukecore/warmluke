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
  count_matching: {
    arity: [1, 6],
    doc: "how many OTHER rows in this section match. A { field } arg means the sibling must share this row's value for it; an operator arg is a test run against the sibling, where { field } reads the SIBLING's value. So `count_matching(order_id, verified != \"Complete\")` is \"how many of this order's other lines are still unverified\" — `= 0` on the row being finished means it was the last one. Use `> 0` with fields alone to catch a duplicate or a clash",
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
} as const satisfies Record<string, ViewSpecDoc>;

export type ViewType = keyof typeof VIEWS;
export const VIEW_TYPES = Object.keys(VIEWS) as ViewType[];

// ── Automation triggers ──────────────────────────────────────
// The last vocabulary that lived only in hand-written prompt text and
// a hardcoded list in the validator. "schedule" was barely mentioned,
// so the assistant rarely reached for it — and a rule that notices
// without being asked is the whole reason automations exist.

export const TRIGGERS = {
  record_created: "a row is added",
  record_updated: "a row is changed",
  schedule:
    "nobody touched anything — re-checks every row on its own. This is the only way to catch things that go quiet: an unpaid invoice, a job nobody moved, a follow-up never made. Needs \"every\": hourly, daily or weekly, and its \"when\" picks which rows to act on",
} as const;

export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

// ── Automation actions ───────────────────────────────────────

export const AUTOMATION_ACTIONS = {
  set_fields: "write fields on the row that fired, or on matching rows in another section",
  create_record:
    "add a row to another section, filling its fields from this one. This is how work moves between sections without the owner retyping it: an order that gets refused opens a return, a job marked done raises an invoice, a delivery that fails becomes a callback. Whenever two sections describe the same thing at different stages, the second one should be created by a rule, not by hand — typed twice means the two drift apart",
} as const;

export type AutomationActionType = keyof typeof AUTOMATION_ACTIONS;
export const AUTOMATION_ACTION_TYPES = Object.keys(
  AUTOMATION_ACTIONS
) as AutomationActionType[];

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
  { id: "external_sync", label: "syncing with another system or website" },
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

NOT POSSIBLE ON THIS PLATFORM — never design around these, never describe a workaround for them:
${NOT_SUPPORTED.map((n) => `  - ${n.label}`).join("\n")}`;
}
