// ─────────────────────────────────────────────────────────────
// Every door a merchant goes through, and what Luke and their own AI have
// for it (docs/ai-builder/parity.md, 12 Oct).
//
// Luke said "open the row and edit it yourself" because nobody had
// written down what a merchant can do that he cannot. This is that list:
// each API route method, each database function a screen calls, and each
// table a screen writes straight to. Beside each, Luke's tools and their
// own AI's (MCP) for the same thing, or why there are none: a decision
// only the owner makes, a credential, Warmluke's own plumbing.
//
// scripts/check-parity.mjs reads the code for doors and fails on one not
// listed here, on a tool named here that does not exist, and on an entry
// with neither tools nor a reason. A new screen action lands here first.
//
// Luke's "design" is his design reply: plans the owner approves on its card.
// ─────────────────────────────────────────────────────────────

export type Door = {
  /** "POST /api/records", "rpc abo_x", "write table", or a prefix ending in "*". */
  door: string;
  /** What the merchant does through it, in their words. */
  does: string;
  /** Luke's tools for it. */
  luke?: string[];
  /** Their own AI's tools for it (MCP). */
  mcp?: string[];
  /** Why there is no tool, or only on one side. */
  why?: string;
};

const OWNER = "the owner's own decision, in Warmluke: an AI may say what waits, never decide it";
const CREDENTIAL = "a credential or a connection: the owner's alone, never through an AI";
const PLUMBING = "Warmluke's own plumbing, not something a merchant does";
const CONSOLE = "Warmluke's admin console: never a merchant's door";
const PEOPLE = "who is on their team and what each may see: the owner's, in Settings";

export const DOORS: Door[] = [
  // ── Their rows ────────────────────────────────────────────
  {
    door: "POST /api/records",
    does: "add, change and delete rows; keep their own fields beside a store row",
    luke: ["change_rows", "design"],
    mcp: ["propose_row_change", "propose_change"],
    why: "deleting rows is by hand only for now: an AI asks for changes, never removals",
  },
  {
    door: "POST /api/row-action",
    does: "press a row's button; decide a press or an ask that waits",
    luke: ["change_rows"],
    mcp: ["propose_row_change"],
    why: "deciding is " + OWNER,
  },
  {
    door: "POST /api/store-actions",
    does: "send, dismiss or undo a change to their shop",
    luke: ["propose_store_action"],
    mcp: ["propose_store_action"],
    why: "sending is " + OWNER,
  },
  {
    door: "POST /api/undo",
    does: "undo row edits or a change to their shop",
    why: "Undo is the owner's button on what they did; an AI asks for the change back instead",
  },
  // ── Their app's shape ─────────────────────────────────────
  {
    door: "POST /api/apply",
    does: "approve a design: sections, fields, rules, views",
    luke: ["design"],
    mcp: ["propose_change", "submit_design"],
    why: "approving is " + OWNER,
  },
  {
    door: "* /api/modules",
    does: "add, rename, move, nest and delete sections; read them",
    luke: ["design", "read_section"],
    mcp: ["propose_change", "read_section"],
  },
  {
    door: "POST /api/rollback",
    does: "put a build back",
    luke: ["design"],
    mcp: ["undo_build"],
    why: "Luke asks for the earlier version as a design; read_section history says what it held",
  },
  { door: "write automations", does: "turn a rule on or off", luke: ["design"], mcp: ["propose_change"] },
  { door: "write modules", does: "share a section with the team", why: PEOPLE },
  { door: "rpc abo_rule_log", does: "see what a rule did", luke: ["rule_runs"], mcp: ["rule_runs"] },
  {
    door: "rpc abo_section_stats",
    does: "see a section's numbers",
    luke: ["read_section", "store_metrics"],
    mcp: ["read_section", "store_metrics"],
  },
  // ── Their store ───────────────────────────────────────────
  { door: "rpc abo_store_overview", does: "the Overview", luke: ["store_overview"], mcp: ["store_overview"] },
  { door: "rpc abo_store_columns", does: "which store columns a list shows", why: PLUMBING },
  { door: "rpc abo_store_set_history", does: "how much store history to bring in", why: CREDENTIAL },
  { door: "rpc abo_store_trim_history", does: "drop older store history", why: OWNER },
  { door: "rpc abo_set_auto_send", does: "let changes to the shop go without a yes", why: OWNER },
  { door: "rpc abo_store_actions_on", does: "whether shop changes may be asked for", why: OWNER },
  { door: "write stores", does: "disconnect their store", why: CREDENTIAL },
  { door: "* /api/shopify/*", does: "connect, import and hear from their Shopify store", why: CREDENTIAL },
  { door: "* /api/connectors*", does: "connect couriers and ad accounts", why: CREDENTIAL },
  { door: "rpc abo_my_shopify_app*", does: "their own Shopify app's keys", why: CREDENTIAL },
  { door: "GET /api/fx", does: "money in another currency on screen", why: PLUMBING },
  // ── The bell ──────────────────────────────────────────────
  {
    door: "rpc abo_alerts*",
    does: "see what Warmluke noticed, and mark it read",
    luke: ["whats_waiting"],
    mcp: ["whats_waiting"],
  },
  { door: "rpc abo_alert_settings", does: "which alerts are on", why: OWNER },
  { door: "rpc abo_set_alert_setting", does: "turn an alert on or off", why: OWNER },
  {
    door: "rpc abo_follow_ups",
    does: "a build nobody used, asked about",
    luke: ["whats_waiting"],
    mcp: ["whats_waiting", "pending_changes"],
  },
  {
    door: "rpc abo_problem_check_ins",
    does: "a problem, a week after its fix, asked about",
    luke: ["whats_waiting"],
    mcp: ["whats_waiting", "pending_changes"],
  },
  { door: "rpc abo_answer_follow_up", does: "answer whether a build worked", why: OWNER },
  { door: "rpc abo_answer_problem", does: "answer whether a problem is better", why: OWNER },
  { door: "rpc abo_approve_request", does: "approve a design their AI asked for", why: OWNER },
  { door: "write build_requests", does: "dismiss a design their AI asked for", why: OWNER },
  // ── Luke himself ──────────────────────────────────────────
  { door: "* /api/chat", does: "talk to Luke", why: "Luke himself" },
  { door: "write conversations", does: "start, name and delete threads with Luke", why: "Luke himself" },
  { door: "write messages", does: "a thread's messages", why: "Luke himself" },
  { door: "rpc abo_supersede_from", does: "send a message again from an earlier point", why: "Luke himself" },
  { door: "* /api/feedback", does: "thumbs on Luke's replies", why: "their verdict on Luke's own replies" },
  { door: "* /api/luke-notes", does: "see and strike what Luke knows", why: "their control over Luke's memory" },
  { door: "* /api/luke-skills", does: "see and strike what Luke learned", why: "their control over Luke's memory" },
  { door: "GET /api/models", does: "pick Luke's model", why: OWNER },
  { door: "rpc abo_meet_luke_again", does: "meet Luke again (tester)", why: PLUMBING },
  { door: "* /api/mcp", does: "their own AI itself", why: "their own AI itself" },
  { door: "rpc abo_oauth_*", does: "see and revoke their connected AIs", why: CREDENTIAL },
  // ── Account, people, onboarding ───────────────────────────
  { door: "* /api/projects", does: "make, rename and delete an app", why: OWNER },
  { door: "write projects", does: "make an app", why: OWNER },
  { door: "write project_members", does: "add, change and remove people", why: PEOPLE },
  {
    door: "rpc abo_teammates",
    does: "who is on the team",
    why: PEOPLE,
  },
  { door: "rpc abo_names_for", does: "names of the people who did things", why: PLUMBING },
  { door: "rpc abo_member_*", does: "a teammate's own welcome and notes", why: PEOPLE },
  { door: "rpc abo_seat_welcome", does: "a teammate's first visit", why: PEOPLE },
  { door: "rpc abo_invite_*", does: "open and claim an invite", why: PEOPLE },
  { door: "rpc abo_join", does: "join a team", why: PEOPLE },
  { door: "write profiles", does: "their own profile and onboarding answers", why: "their own account" },
  { door: "rpc abo_my_settings", does: "their own account settings", why: "their own account" },
  { door: "rpc abo_may_start_app", does: "whether a new app may be made", why: PLUMBING },
  { door: "rpc abo_tour_seen", does: "the tour, seen", why: PLUMBING },
  { door: "rpc abo_seen", does: "what is new, seen", why: PLUMBING },
  { door: "rpc abo_whats_new", does: "what is new in Warmluke", why: PLUMBING },
  { door: "rpc abo_shopify_internal", does: "whether internal Shopify mode is on", why: PLUMBING },
  { door: "rpc abo_is_superadmin", does: "the console's own gate", why: CONSOLE },
  { door: "rpc abo_admin_*", does: "the admin console", why: CONSOLE },
  { door: "POST /api/console", does: "the admin console", why: CONSOLE },
  { door: "rpc abo_book_demo", does: "book a demo from the landing page", why: PLUMBING },
  { door: "write landing_events", does: "the landing page's own counts", why: PLUMBING },
  { door: "write screen_errors", does: "a written screen's error, kept for a fix", why: PLUMBING },
  // ── Workers and webhooks ──────────────────────────────────
  { door: "POST /api/code-rules/worker", does: "rules run with nobody watching", why: PLUMBING },
  { door: "* /api/spike/*", does: "a developer's spike", why: PLUMBING },
];

/** Whether a door a check found is this entry's: exactly, or under a prefix ending in "*". */
export function covers(entry: string, door: string): boolean {
  if (!entry.includes("*")) return entry === door;
  const re = new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(door);
}
