// ─────────────────────────────────────────────────────────────
// Warmluke — shared types.
// Closed sets are deliberate: the AI can only emit these, and the
// engine only knows these. Business logic is DATA (automations),
// never generated code.
// ─────────────────────────────────────────────────────────────

export { COLUMN_TYPES, type ColumnType } from "./capabilities";
import type { ColumnType, ExprOp } from "./capabilities";

export interface SchemaColumn {
  field: string;
  label: string;
  type: ColumnType;
  /**
   * For type "link": the section this points at — a module id, or a
   * "#slug" when that section is created in the same batch. The record
   * stores the linked row's id, never a copy of its text.
   */
  linkTo?: string;
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

export interface AutomationTrigger {
  type: "record_created" | "record_updated" | "schedule";
  /** For schedule type; the engine runs hourly and filters with `when`. */
  every?: "hourly" | "daily" | "weekly";
  /** One expression deciding whether the rule fires. */
  when?: Expr;
}

export type AutomationAction =
  | {
      type: "set_fields";
      /** The row that fired the rule, or rows matched in another section. */
      target:
        | { self: true }
        | { module_id: string; match: { field: string; to: Expr } };
      /** field -> expression evaluated per matched row. */
      set: Record<string, Expr>;
    }
  | { type: "create_record"; module_id: string; data: Record<string, Expr> }
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
    };

// ── Module-level features (all AI-editable via prompt) ───────

export interface FeatureSchema {
  /** How this section is rendered. Defaults to a plain table if absent. */
  view?: ViewSpec;
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
  }>;
  defaultSort?: { field: string; dir: "asc" | "desc" };
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
    /** Applied to the scanned row; values are expressions, as elsewhere. */
    action: { label: string; set: Record<string, Expr> };
    /** Optional: block if this numeric field is lower than the last scan. */
    sequenceField?: string;
    hint?: string;
  };
}

export interface UiSchema {
  columns: SchemaColumn[];
  features?: FeatureSchema | null;
}

// ── Core rows ────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  /** BCP-47 tag driving number and date formatting. */
  locale: string;
  /** ISO 4217 code driving money formatting. */
  currency: string;
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
  status: "pending" | "connected" | "disconnected";
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
  created_at: string;
}

export interface RecordRow {
  id: string;
  project_id: string;
  module_id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
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
}

export type AssistantReply =
  | { type: "clarify"; message: string; questions: ClarifyQuestion[] }
  | { type: "blueprint"; message: string; blueprint: Blueprint }
  | { type: "plans"; message?: string; plans: AssistantPlan[] };

export type ReplyType = AssistantReply["type"];

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

const BADGE_PALETTE = [
  "bg-blue-100 text-blue-800 ring-blue-200",
  "bg-emerald-100 text-emerald-800 ring-emerald-200",
  "bg-amber-100 text-amber-800 ring-amber-200",
  "bg-violet-100 text-violet-800 ring-violet-200",
  "bg-rose-100 text-rose-800 ring-rose-200",
  "bg-cyan-100 text-cyan-800 ring-cyan-200",
  "bg-indigo-100 text-indigo-800 ring-indigo-200",
  "bg-teal-100 text-teal-800 ring-teal-200",
  "bg-orange-100 text-orange-800 ring-orange-200",
  "bg-sky-100 text-sky-800 ring-sky-200",
  "bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200",
  "bg-lime-100 text-lime-800 ring-lime-200",
] as const;

export function badgeColorFor(value: string): string {
  const key = value.trim().toLowerCase();
  if (!key) return "bg-slate-100 text-slate-700 ring-slate-200";
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return BADGE_PALETTE[Math.abs(hash) % BADGE_PALETTE.length];
}

// ── Sidebar icon whitelist ───────────────────────────────────

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
