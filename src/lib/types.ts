// ─────────────────────────────────────────────────────────────
// Warmluke — shared types.
// Closed sets are deliberate: the AI can only emit these, and the
// engine only knows these. Business logic is DATA (automations),
// never generated code.
// ─────────────────────────────────────────────────────────────

export { COLUMN_TYPES, type ColumnType } from "./capabilities";
import type { ColumnType, ExprOp } from "./capabilities";
import type { DesignChecks } from "./review-types";
import type { ScreenShown } from "./screen";

export interface SchemaColumn {
  field: string;
  label: string;
  type: ColumnType;
  /** For money imported with a per-row ISO currency code. */
  currencyField?: string;
  /**
   * For type "link": the section this points at — a module id, or a
   * "#slug" when that section is created in the same batch. The record
   * stores the linked row's id, never a copy of its text.
   */
  linkTo?: string;
  /**
   * Worked out when the row is read, not stored.
   *
   * A merchant asking to "flag products running out" wants a column
   * saying Low or OK. Storing that means a rule has to write it, which
   * means it is right only until the number beside it changes — and on
   * rows synced from a shop, an import would overwrite it anyway. So
   * the section keeps the expression instead of the answer, and the
   * answer is computed every time the page opens.
   *
   * Nobody writes to one: it is not offered in the editor, and a rule
   * or a button that tries to set it is refused when the design is
   * checked.
   */
  compute?: Expr;
  /**
   * Off the table, board and cards, and still in the row when it is
   * opened, and in its data. How a column comes off the table: a store
   * column can only be hidden, never removed, and "RTO marked on, only
   * when I open the row" is a hidden column (Tanish, 3 Oct).
   */
  hidden?: boolean;
  /**
   * The owner renamed it (Customize, lib/view-edit). On a store column
   * this name is kept over ours; a saved label without it is ours from
   * the day it was saved, and is not (lib/store-read storeSectionColumns).
   */
  named?: boolean;
}

// ── Automations: business logic as expression trees ──────────
// The rules a business needs are not a list we can enumerate in
// advance, so we do not try. The assistant composes them from
// operators, and Postgres evaluates the tree on every write
// (see migration 0010). Still data, never generated code.

export { EXPR_OPS, type ExprOp } from "./capabilities";

/**
 * A node is either a leaf that reads a value, or an operator applied to
 * other nodes. Leaves: const = literal; field = the row that fired the
 * rule; was = that row's value before the write; target = the row an
 * action is currently writing to.
 */
export type Expr =
  | { const: string | number | boolean | null }
  | { field: string }
  | { was: string }
  | { target: string }
  | { op: ExprOp; args?: Expr[] };

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface AutomationTrigger {
  /** store_row_added: a row the store brought in (0134), for a rule's own code on a section over the store. */
  /** before_save: a row about to be saved, which its rule may refuse (0143). */
  type: "record_created" | "record_updated" | "schedule" | "store_row_added" | "before_save";
  /** For schedule type: how often, filtering its rows with `when` (0137). */
  every?: "hourly" | "daily" | "weekly" | "monthly";
  /** Schedule: the time it runs, "HH:MM" on the store's clock (daily, weekly, monthly). */
  at?: string;
  /** Schedule: the days of the week it runs (daily or weekly). */
  on?: Weekday | Weekday[];
  /** Schedule, monthly: the day of the month, 1 to 31; past a month's end, its last day. */
  date?: number;
  /** One expression deciding whether the rule fires. */
  when?: Expr;
}

export type AutomationAction =
  | {
      type: "set_fields";
      /** The row that fired the rule, or rows matched in another section. */
      target: { self: true } | { module_id: string; match: { field: string; to: Expr } };
      /** field -> expression evaluated per matched row. */
      set: Record<string, Expr>;
    }
  | { type: "create_record"; module_id: string; data: Record<string, Expr> }
  /** The rule's own function, run sealed off (lib/code-run.ts), for logic the expressions cannot say. */
  | { type: "run_code"; code: string; reads?: string[] }
  /** Stop the save, in the owner's words: only on a before_save rule (0143). Nothing is written. */
  | { type: "refuse"; message: string }
  /** Tell the owner, in the bell and on the Overview (0164): a title, and up to four of the row's fields. */
  | { type: "alert"; title: string; show?: string[]; severity?: "attention" | "critical" }
  | { type: "webhook"; url: string };

export interface AutomationDefinition {
  trigger: AutomationTrigger;
  actions: AutomationAction[];
}

export interface AutomationRow {
  id: string;
  project_id: string;
  module_id: string | null;
  name: string;
  enabled: boolean;
  definition: AutomationDefinition;
  created_at: string;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  record_id: string | null;
  ok: boolean;
  detail: Record<string, unknown> | null;
  created_at: string;
}

// ── Views ────────────────────────────────────────────────────
// How a section is DISPLAYED is a decision the assistant makes per
// problem, not a default. A repair shop with stages wants a board; a
// rental business wants a calendar; a price list wants a table. The
// engine renders whichever of these the plan asks for.

export { VIEW_TYPES, type ViewType } from "./capabilities";

export type ViewSpec =
  | { type: "table" }
  /** Columns of cards grouped by a badge/dropdown field — one column per stage. */
  | { type: "board"; groupBy: string; cardTitle: string; cardFields?: string[] }
  /** Month grid; each record sits on the day in dateField. */
  | { type: "calendar"; dateField: string; titleField: string; colorBy?: string }
  /** Tiles — for browsing a catalogue of things rather than scanning rows. */
  | {
      type: "cards";
      titleField: string;
      subtitleField?: string;
      badgeField?: string;
      fields?: string[];
    }
  /** One line per record — for queues and simple checklists. */
  | {
      type: "list";
      titleField: string;
      secondaryField?: string;
      badgeField?: string;
      metaField?: string;
    }
  /** A screen Luke wrote for a flow none of the others draws, run sealed off (lib/custom-view.ts). */
  | { type: "custom"; title: string; html: string };

// ── Module-level features (all AI-editable via prompt) ───────

export interface FeatureSchema {
  /** How this section is rendered. Defaults to a plain table if absent. The first tab when there are tabs. */
  view?: ViewSpec;
  /**
   * More views of the same rows, as tabs after the first (`view`): a
   * written packing screen beside Orders' table, a board by stage beside
   * a list. A section had one view, so a screen asked for over Orders
   * took its table away. On a section over the store a written screen is
   * only ever a tab here, never `view`. A tab's name is its "label", or a
   * written screen's title. At most four.
   */
  tabs?: Array<ViewSpec & { label?: string }>;
  search?: { enabled: boolean; fields?: string[]; placeholder?: string };
  filters?: Array<{ field: string; label: string; options: string[] }>;
  /**
   * Stat cards. "value" is an expression evaluated per row and then
   * aggregated, so a total can be quantity x price — a bare field name
   * could only ever add up one column.
   */
  stats?: Array<{
    label: string;
    op: "count" | "sum" | "avg" | "min" | "max";
    value?: Expr;
    /** Legacy shorthand for { field }; still honoured when reading. */
    field?: string;
    format?: "number" | "currency";
    /** Only rows where this is true are counted. */
    where?: Expr;
    /** Group rows by this field and show the top few: "sales by city". */
    by?: string;
    /** How many groups to show, 1–20. Default 5. */
    limit?: number;
  }>;
  defaultSort?: { field: string; dir: "asc" | "desc" };
  /**
   * A choice of dates over the section (0161): chips that set the window
   * its rows, its stat cards and its view are read over. "Last N days"
   * is today and the N - 1 before it, in the shop's zone on a section
   * over the store. Their own dates, and every row, are always offered.
   */
  period?: {
    /** A date column: the day each row happened. */
    field: string;
    /** What the chips are over ("Placed"); the column's own label when left out. */
    label?: string;
    /** The windows offered, in days. Default 7, 30 and 90. */
    presets?: number[];
    /** The window it opens on, one of the presets; every row when left out. */
    default?: number | null;
  };
  /**
   * Row action buttons. The guard and the values written are the same
   * expression trees automations use, so "only when it isn't already
   * done" or "stamp today's date" need no new vocabulary.
   */
  actions?: Array<{
    label: string;
    /** field -> expression, evaluated against the row when clicked. */
    set: Record<string, Expr>;
    /** Shown only when this evaluates true for the row. */
    when?: Expr;
    style?: "primary" | "danger" | "neutral";
  }>;
  /** Scan mode: camera barcode scan → find record → apply action. */
  scanMode?: {
    /** Which barcode field to scan into for lookup. */
    lookupField: string;
    /** Other fields a scan may match too: a maker's barcode beside the SKU. */
    alsoMatch?: string[];
    /**
     * A first scan that opens one group: the order's label, then the items
     * in that order. `field` is what every row of the group shares; the
     * item scans after it match only that group's rows.
     */
    first?: { field: string; label?: string };
    /** When this holds for every row of the open group, the group is done and the bar goes back to its first scan. */
    done?: Expr;
    /** Applied to the scanned row; values are expressions, as elsewhere. */
    action: { label: string; set: Record<string, Expr> };
    /** Optional: block if this numeric field is lower than the last scan. */
    sequenceField?: string;
    hint?: string;
  };
}

/**
 * A change to a section's features, laid over what it has: a part the
 * change names (view, tabs, stats, filters, actions, scanMode, search,
 * defaultSort, period) replaces that part, a part it leaves out stays, and null
 * takes it away. A change used to replace them all, so to add one
 * counter Luke sent every part back, and a part he missed was gone: a
 * counter on a written screen meant sending the whole screen again.
 */
export function mergeFeatures(
  current: FeatureSchema | null | undefined,
  change: FeatureSchema | Record<string, unknown> | null | undefined
): FeatureSchema {
  const out: Record<string, unknown> = { ...current };
  for (const [part, value] of Object.entries(change ?? {})) {
    if (value === null) delete out[part];
    else if (value !== undefined) out[part] = value;
  }
  return out as FeatureSchema;
}

export interface UiSchema {
  columns: SchemaColumn[];
  features?: FeatureSchema | null;
}

// ── Core rows ────────────────────────────────────────────────

export interface ProjectRow {
  /**
   * Designs from an AI apply without waiting for approval.
   * Per project, because the risk is the app's: on for something
   * being played with, off for the one staff use every day.
   */
  auto_build?: boolean;
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  /** BCP-47 tag driving number and date formatting. */
  locale: string;
  /** ISO 4217 code driving money formatting. */
  currency: string;
  /**
   * Whether the owner actually chose that currency.
   *
   * False means the column is holding its default, not an answer. An
   * imported amount is shown in the shop's own currency either way;
   * this decides whether a rough line in the project's currency is
   * worth putting underneath it.
   */
  currency_set_by_user?: boolean;
  created_at: string;
}

/** A commerce account connected to a project — one store per project. */
export interface StoreRow {
  id: string;
  project_id: string;
  provider: string;
  shop_domain: string;
  /** The store's own calendar. Every "yesterday" is asked in this zone. */
  timezone: string;
  currency: string;
  country: string | null;
  connected_at: string | null;
  /** Null until an import has actually run — which is not the same as connected. */
  last_synced_at: string | null;
  history_from: string | null;
  /**
   * When Shopify's access token stops working. Shopify no longer issues
   * non-expiring ones, so a connected store whose expiry has passed and
   * which cannot be refreshed has to be reconnected — the dashboard says
   * so rather than leaving a green dot on a store that answers 403.
   */
  token_expires_at: string | null;
  /**
   * When the 90-day refresh token stops working. THIS is the one that
   * means reconnect: the access token above lasts an hour and is
   * renewed on use, so its expiry passing is the normal state of a
   * store nobody has touched since lunch.
   */
  refresh_token_expires_at: string | null;
  /** "uninstalled": Shopify said the app was removed from the store (0111). */
  status: "pending" | "connected" | "disconnected" | "uninstalled";
  created_at: string;
}

export interface ModuleRow {
  id: string;
  project_id: string;
  /** Set when this section sits inside another. One level only. */
  parent_id: string | null;
  name: string;
  nav_label: string;
  icon: string;
  route: string;
  sort_order: number;
  /**
   * Set when the section shows the connected store's rows instead of
   * rows the merchant typed. Read-only in the app — the import owns
   * those rows and would overwrite an edit made here.
   */
  source_table: string | null;
  /** Everyone on the team sees it (0140). Off, only the owner and those it is shared with. Absent before 0140: shared. */
  shared_with_team?: boolean;
  /** The login that built it (0145); null for sections from before. */
  created_by?: string | null;
  /** Not a column: set for a turn by someone the owner lets build, on what they did not build (0146). */
  read_only?: boolean;
  created_at: string;
}

export interface RecordRow {
  id: string;
  project_id: string;
  module_id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** The logins that added it and last changed it, from the session (0144); null when no person did. */
  created_by?: string | null;
  updated_by?: string | null;
}

export interface UiSchemaRow {
  id: string;
  module_id: string;
  schema_json: UiSchema;
  version: number;
  created_by: "ai" | "user";
  change_description: string | null;
  created_at: string;
}

// ── AI assistant contract ────────────────────────────────────

export interface AssistantPlan {
  changeType: ChangeType;
  targetModuleId: string | null;
  newModule: {
    name: string;
    nav_label: string;
    icon: string;
    /** Section this sits inside — a uuid, a "#slug" from this batch, or null. */
    parent_id?: string | null;
    /**
     * Rows come from the connected store instead of from records the
     * merchant types: "orders", "customers", "products",
     * "inventory_levels", "product_sales". Read-only, and its columns
     * are the store's.
     */
    source_table?: string | null;
  } | null;
  newSchema: UiSchema;
  moduleUpdate: {
    nav_label?: string;
    icon?: string;
    sort_order?: number;
    parent_id?: string | null;
  } | null;
  deleteConfirmName: string | null;
  features: FeatureSchema | null;
  /** AUTOMATION_ADD: full automation definition. */
  automation: {
    name: string;
    definition: AutomationDefinition;
  } | null;
  /** AUTOMATION_REMOVE: name of the automation to disable. */
  automationRemoveName: string | null;
  newRecords: Array<Record<string, unknown>> | null;
  explanation: string;
  /** In a blueprint: the owner may untick this one before building. */
  optional?: boolean;
  /** Set by the server, never the model: what this leaves waiting, said on its card (lib/ai.ts, a rule turned off). */
  heads_up?: string[];
  /** Required when optional — why it might be worth having. */
  optionalWhy?: string;
}

export type ChangeType =
  | "UI_CHANGE"
  | "FIELD_ADD"
  | "NEW_MODULE"
  | "MODULE_UPDATE"
  | "MODULE_DELETE"
  | "FEATURE_UPDATE"
  | "RECORD_SEED"
  | "AUTOMATION_ADD"
  | "AUTOMATION_REMOVE";

// ── Discovery: the assistant may answer with questions or a
// plain-language blueprint instead of jumping straight to plans.
// This is what makes the loop human-in-the-loop *before* anything
// is built, rather than only at the approve-the-diff step.

export interface ClarifyQuestion {
  id: string;
  question: string;
  /** Why the answer changes the design — shown as a hint. */
  why?: string;
  /** Tappable example answers; the owner can always type their own. */
  suggestions?: string[];
  /**
   * The suggestion Luke would pick itself, when the question is a choice
   * between ways to build it; `why` then says why, in a line.
   */
  recommended?: string;
  /** More than one suggestion can be true at once; otherwise exactly one is picked. */
  multi?: boolean;
}

export interface BlueprintStep {
  step: string;
  /** Which person/role does this step. */
  who: string;
}

/**
 * A design put to the owner for approval.
 *
 * `plans` is not a description of what will be built — it IS what will
 * be built. The blueprint used to be prose the assistant wrote, with
 * the real plans generated in a later turn; nothing tied the two
 * together, and they drifted (a blueprint promised filters, stats and
 * a button; the build delivered only the section). Approving now
 * applies exactly these plans, so the promise and the thing are the
 * same object and cannot disagree.
 */
export interface Blueprint {
  summary: string;
  plans: AssistantPlan[];
  /** The owner's real-world process, in their terms. */
  workflow: BlueprintStep[];
  /**
   * Things the OWNER asked for that this design does not do — quoted
   * back in their own words, never explained in terms of the platform.
   * The interface supplies the wording about what the platform can do,
   * from its own registry.
   */
  unmet?: string[];
  /**
   * What the owner could ask for after this is built — up to two,
   * written by the model from THEIR problem and THIS design, or none.
   * Each is a real prompt; tapping one sends it, and it goes through
   * every gate a typed message does. Never a canned line.
   */
  next?: NextStep[];
}

/** A past conversation as the list shows it: its name, when it last moved, and what it holds. */
export interface ThreadSummary {
  id: string;
  title: string | null;
  updated_at: string;
  /** Builds that landed in it. */
  built?: number;
  answers?: number;
  /** The assistant that started it over MCP (0139), or none for the owner's own. */
  asked_by?: string | null;
  /** Someone else on the team whose thread it is (0146); none for your own. */
  by?: string | null;
}

/** A follow-up the owner could send next, offered once a build lands. */
export interface NextStep {
  /** A few words, as a button. */
  label: string;
  /** The message they would send, in their own vocabulary. */
  prompt: string;
}

export type AssistantReply =
  /**
   * A question answered rather than a change designed.
   *
   * `grounding` is written by the server, never by the model: it says
   * which snapshot the answer was allowed to use and when that data
   * last came from Shopify. A model asserting "I checked" proves
   * nothing; this is the receipt.
   */
  (
    | {
        type: "answer";
        /**
         * What was answered: a question about the store's rows (and
         * only from the rows it was given), a question about Luke or
         * this app, or plain conversation. Absent in replies stored
         * before this existed, which were all about the store.
         */
        kind?: AnswerKind;
        message: string;
        /** What they might ask next, as the model offers it: tapped, each is sent as written. */
        next?: NextStep[];
        /** Done on the section open as this is said (lib/screen.ts): read by code, never saved. */
        show?: ScreenShown;
        /** On a proposal, what was understood, so their yes builds exactly that (lib/plan DesignIntent). */
        understood?: unknown;
        grounding?: {
          kind: "store_snapshot";
          last_synced_at: string | null;
          shop: string;
          /** What the turn looked up beyond the snapshot, as the tools recorded it, not as the model said. */
          looked_up?: string[];
        };
      }
    | {
        type: "clarify";
        message: string;
        questions: ClarifyQuestion[];
        /** Two questions whose answers do not depend on each other, asked at once; otherwise one at a time. */
        together?: boolean;
      }
    | {
        type: "blueprint";
        message: string;
        blueprint: Blueprint;
        /** What the reviewers after the critic said of this design (lib/review-gate.ts), set by the server; kept for its card. */
        checks?: DesignChecks;
      }
    | {
        type: "plans";
        message?: string;
        plans: AssistantPlan[];
        next?: NextStep[];
        /** What the reviewers after the critic said of this design (lib/review-gate.ts), set by the server; kept for its card. */
        checks?: DesignChecks;
      }
  ) & {
    /** Set by the server, never the model: the designs that worked it was shown (lib/examples.ts), so what stuck is counted by them. */
    examples?: string[];
    /** Set by the server, never the model: what the checks caught before the owner saw it (lib/engine.ts), for the superadmin's eyes. */
    caught?: { sentBack?: string; refused?: string[] };
    /**
     * Set by the server, never the model: the owner said yes to this design
     * in words before it was drawn (a proposal, then "build it"), so the
     * chat builds it without asking again.
     */
    approved?: boolean;
    /**
     * What the conversation is about so far, in a few of the owner's own
     * words: the thread's name in the list, in place of whatever was typed
     * first. Kept while the subject holds.
     */
    title?: string;
    /** What the turn's model calls took, written by the server (lib/usage.ts), never the model. */
    usage?: TurnUsage;
    /** What the turn did to arrive here and how long it took, as the server told it (lib/trace.ts keeps the same). */
    trace?: { steps: TurnEvent[]; ms: number };
  };

/** What a model call was for: the reply itself, the gap pass, or routing the question. */
export type UsageJob =
  | "reply"
  | "gap"
  | "route"
  | "plan"
  | "critic"
  | "memory"
  | "reflect"
  | "ops"
  | "review"
  | "ux"
  | "tryout";

/** One model's share of a turn: its calls for one job, their tokens, and their dollars. */
export type ModelUse = {
  provider: string;
  /** As the provider named it in its answer, which is the model that did the work. */
  model: string;
  job: UsageJob;
  calls: number;
  /** Every input token, cached ones included. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Null when this model's price is not known. */
  usd: number | null;
};

/** A turn's usage, as the reply keeps it: priced once, when the turn ended. */
export type TurnUsage = {
  /** The model whose answer is the reply; null when no reply call finished. */
  model: string | null;
  uses: ModelUse[];
  /** Dollars for the calls with a known price. */
  usd: number;
  /** Some call had no known price, so usd is not the whole of it. */
  partial: boolean;
};

/** What each reply says under it about the model: set per account by an administrator (0127). */
export type LukeShows = "nothing" | "model" | "tokens" | "cost";

/** "proposal": a design said in words before it is built, ending "Want me to build it?" (lib/plan). */
export type AnswerKind = "store" | "product_help" | "conversation" | "proposal";

export type ReplyType = AssistantReply["type"];

/**
 * What a turn is doing, said as it happens.
 *
 * Each one is sent the moment that step actually starts or ends, with
 * what it found — never on a timer, never before the fact. The chat
 * route streams them ahead of the reply so the panel can show the
 * work instead of a dot; the panel puts words to them, and only the
 * words are its own.
 */
export type TurnEvent =
  /** The turn has been charged and is running. */
  | {
      step: "accepted";
      /** The thread the question was kept in, and the line its answer will fill. */
      conversationId?: string;
      turn?: string;
    }
  /** The store was read. `read` names the rows a routed question pulled, when it did. */
  | { step: "store"; shop: string | null; read: string | null }
  /** Every section's columns and the rules were read. */
  | { step: "context"; sections: number; rules: number }
  /** The model is being asked, for the n-th time of at most `of`. */
  | { step: "model"; attempt: number; of: number }
  /** Which road the turn took: only how to answer, or the whole design contract. */
  | { step: "road"; road: "talk" | "design" }
  /** Before a design: told with no goal when the plan starts, and with the goal once it is understood. */
  | { step: "plan"; goal: string | null }
  /** The model looked something up with a store tool, and it came back. `about` is what, in words. */
  | { step: "lookup"; about: string }
  /** A change to the shop was asked for; it waits for the merchant's yes. `summary` is the card's own sentence. */
  | { step: "proposed"; summary: string }
  /** The validator has spoken: no problems, or this many going back to the model. */
  /** parts: what the design builds, by name, when it passed ("Add fields to Orders"). */
  | { step: "checked"; problems: number; parts?: string[] }
  /** A design came out; the pass that finds what it misses is running. */
  | { step: "gaps"; parts?: string[] }
  /** The critic read the design against what was asked: it fits, or it went back once. `missing` counts what it still lacks. */
  | { step: "critic"; verdict: "fits" | "redo"; missing: number }
  /** The operator's view before the plan: told with null when it starts, and with how many ideas it had once back. */
  | { step: "ops"; ideas: number | null }
  /** The simplicity reviewer read the design: as simple as it can be, or a simpler build would do the same job. */
  | { step: "simplicity"; verdict: "simple" | "redo" }
  /** The design was checked against the store's own rows: how many findings are problems, how many only notes. */
  | { step: "data"; problems: number; notes: number }
  /** The design's rules were tried on the rows they would meet: how many, and the rows they match in all (null when it cannot be told). */
  | { step: "dryrun"; rules: number; matched: number | null }
  /** The screen review looked at the design's screens: how it saw them, and whether they pass. */
  | { step: "ux"; verdict: "pass" | "redo" | "skipped"; how: "screenshot" | "text" | "none" }
  /** The design was used as the merchant will (lib/tryout.ts): how many parts were tried, and how many broke. */
  | { step: "tryout"; tried: number; problems: number };

// ── Conversation persistence ─────────────────────────────────

export interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  payload: AssistantReply | null;
  created_at: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ── Badge colours ────────────────────────────────────────────
// Derived from the value itself, not a lookup table. A hardcoded map
// only ever knew shop words ("shipped", "refunded") and fell back to
// grey for everyone else — a clinic's "Discharged" or a farm's "Sown"
// got nothing. Hashing gives every vocabulary, in any language, stable
// and distinguishable colours.

// ── Sidebar icon whitelist ───────────────────────────────────

/** The most a thread title holds. Three places cut one; they cut the same. */
export const TITLE_MAX = 80;

export const ALLOWED_ICONS = [
  "shopping-cart",
  "package",
  "users",
  "receipt",
  "calendar",
  "clipboard-list",
  "undo-2",
  "box",
  "heart",
  "wrench",
  "globe",
  "truck",
  "wallet",
  "target",
  "scan-line",
  "table",
] as const;
