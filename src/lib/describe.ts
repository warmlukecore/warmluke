// ─────────────────────────────────────────────────────────────
// Turns an expression tree back into a sentence. The owner approves
// and audits rules they never wrote in JSON, so this is the only
// form of them they ever see.
// ─────────────────────────────────────────────────────────────

import type {
  AssistantPlan,
  AutomationDefinition,
  AutomationTrigger,
  ClarifyQuestion,
  Expr,
  FeatureSchema,
  ModuleRow,
  ViewSpec,
} from "./types";
import { STORE_TABLES, isStoreTable, storeTableSchema } from "./store-read";
import { openingPick, presetsOf } from "./period";
import { tabName } from "./tabs";

/** Renders an expression tree as something a non-technical owner reads. */
export function exprText(e: Expr | undefined): string {
  if (!e) return "";
  if ("const" in e) return String(e.const);
  if ("field" in e) return e.field;
  if ("was" in e) return `previous ${e.was}`;
  if ("target" in e) return `their ${e.target}`;

  const a = (e.args ?? []).map(exprText);
  switch (e.op) {
    case "and":
      return a.join(" and ");
    case "or":
      return a.join(" or ");
    case "not":
      return `not ${a[0]}`;
    case "=":
      return `${a[0]} is ${a[1]}`;
    case "!=":
      return `${a[0]} is not ${a[1]}`;
    case ">":
      return `${a[0]} is more than ${a[1]}`;
    case ">=":
      return `${a[0]} is at least ${a[1]}`;
    case "<":
      return `${a[0]} is less than ${a[1]}`;
    case "<=":
      return `${a[0]} is at most ${a[1]}`;
    case "contains":
      return `${a[0]} contains “${a[1]}”`;
    case "starts_with":
      return `${a[0]} starts with “${a[1]}”`;
    case "is_empty":
      return `${a[0]} is blank`;
    case "is_set":
      return `${a[0]} is filled in`;
    case "changed":
      return `${a[0]} just changed`;
    case "days_since":
      return `days since ${a[0]}`;
    case "count_matching": {
      const args = e.args ?? [];
      const fields = args
        .filter((x): x is { field: string } => !!x && "field" in x)
        .map((x) => x.field)
        .join(" and ");
      const conds = args.filter((x) => !!x && "op" in x).map(exprText);
      const where = conds.length > 0 ? ` where ${conds.join(" and ")}` : "";
      return `other rows with the same ${fields}${where}`;
    }
    case "sum_matching": {
      const [value, ...rest] = e.args ?? [];
      const fields = rest
        .filter((x): x is { field: string } => !!x && "field" in x)
        .map((x) => x.field)
        .join(" and ");
      const conds = rest.filter((x) => !!x && "op" in x).map(exprText);
      const where = conds.length > 0 ? ` where ${conds.join(" and ")}` : "";
      return `the ${exprText(value)} of other rows with the same ${fields}${where}, added up`;
    }
    case "store_value": {
      // store_value("inventory_levels", "available", "inventory_item_id", item, …)
      const [list, field, ...pairs] = a;
      const by: string[] = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) by.push(`${pairs[i]} ${pairs[i + 1]}`);
      return `the store's ${field} in ${list.replace(/_/g, " ")} for ${by.join(", ")}`;
    }
    case "if":
      return `${a[1]} if ${a[0]}, otherwise ${a[2] ?? "nothing"}`;
    case "round":
      return `rounded ${a[0]}`;
    case "today":
      return "today";
    case "now":
      return "right now";
    case "+":
      return a.join(" plus ");
    case "-":
      return a.join(" minus ");
    case "*":
      return a.join(" times ");
    case "/":
      return a.join(" divided by ");
    case "concat":
      return a.join(" + ");
    default:
      return a.join(` ${e.op} `);
  }
}

/** A rule row, as the database keeps it. */
export type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  module_id: string | null;
  definition: AutomationDefinition;
};

const DAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const ordinal = (n: number) =>
  `${n}${n === 1 || n === 21 || n === 31 ? "st" : n === 2 || n === 22 ? "nd" : n === 3 || n === 23 ? "rd" : "th"}`;

/**
 * "Every day at 07:00", "Every Monday and Saturday at 09:00", "Every month
 * on the 1st", on the store's clock. Null for an interval alone, which
 * keeps its words ("daily"): the critic's recordings hold them.
 */
export function scheduleWords(t: AutomationTrigger): string | null {
  if (t.every !== "monthly" && t.at === undefined && t.on === undefined) return null;
  const at = t.at ? ` at ${t.at}` : "";
  const days = (Array.isArray(t.on) ? t.on : t.on ? [t.on] : []).map((d) => DAY_NAMES[String(d).toLowerCase()] ?? d);
  const named = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : days[0];
  switch (t.every) {
    case "weekly":
      return `Every ${named}${at}`;
    case "monthly":
      return `Every month on the ${ordinal(t.date ?? 1)}${at}`;
    default:
      return named ? `Every ${named}${at}` : `Every day${at}`;
  }
}

/**
 * The rules already running, in the words the approval card uses.
 *
 * Nothing told the designer these existed. Not the chat box, not a
 * connected assistant — so both would answer "there is no such rule"
 * about a rule that runs every day, or propose a second one beside it.
 * A designer that cannot see what is there designs over the top of it.
 */
export function describeRules(rules: RuleRow[], modules: Array<{ id: string; nav_label: string }>): string[] {
  return rules.map((r) => {
    const where = modules.find((m) => m.id === r.module_id)?.nav_label;
    const lines = describeAutomation(r, modules).join("; ");
    return `“${r.name}”${where ? ` on ${where}` : ""}${r.enabled ? "" : " (turned off)"} — ${lines}`;
  });
}

export function describeAutomation(
  auto: { name: string; definition: AutomationDefinition },
  modules: Array<{ id: string; nav_label: string }>
): string[] {
  const d = auto.definition;
  const out: string[] = [];
  const t = d.trigger;

  const cond = t?.when ? exprText(t.when) : "";
  if (t?.type === "record_created") {
    out.push(cond ? `When a row is added and ${cond}` : "When a row is added");
  } else if (t?.type === "record_updated") {
    out.push(cond ? `When ${cond}` : "When a row is edited");
  } else if (t?.type === "before_save") {
    // A rule that says no (0143): what it refuses, before anything is written.
    out.push(cond ? `Before a row is saved, refuse it if ${cond}` : "Before a row is saved");
  } else if (t?.type === "store_row_added") {
    out.push(cond ? `When the store brings in a row where ${cond}` : "When the store brings in a row");
  } else if (t?.type === "schedule") {
    const every = t.every ?? "daily";
    const when = scheduleWords(t) ?? `${every[0].toUpperCase()}${every.slice(1)}`;
    out.push(cond ? `${when}, for rows where ${cond}` : (scheduleWords(t) ?? every));
  }

  const nameFor = (id: string) =>
    id?.startsWith("#") ? id.slice(1) : (modules.find((m) => m.id === id)?.nav_label ?? "another section");

  for (const a of d.actions ?? []) {
    if (a.type === "set_fields") {
      const sets = Object.entries(a.set)
        .map(([f, v]) => `${f} = ${exprText(v)}`)
        .join(", ");
      if ("self" in a.target) {
        out.push(`→ on this row, set ${sets}`);
      } else {
        out.push(
          `→ in ${nameFor(a.target.module_id)}, find rows where ${a.target.match.field} is ${exprText(
            a.target.match.to
          )} and set ${sets}`
        );
      }
    } else if (a.type === "create_record") {
      out.push(`→ add a row to ${nameFor(a.module_id)}`);
    } else if (a.type === "refuse") {
      out.push(`→ refuse, saying “${a.message}”`);
    } else if (a.type === "alert") {
      // Said as the owner will meet it: in the bell, with what it shows.
      out.push(`→ tell you in the bell: “${a.title}”${a.show?.length ? `, with ${a.show.join(", ")}` : ""}`);
    } else if (a.type === "webhook") {
      out.push("→ call an external service");
    }
  }
  return out;
}

// ── Plans ────────────────────────────────────────────────────

/** Every feature a plan configures, stated from the config itself. */
// A written screen, told by what it says on it: its words, not its code.
const said = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
const detailOf = (v: ViewSpec) =>
  v.type === "board" ? ` grouped by ${v.groupBy}` : v.type === "calendar" ? ` by ${v.dateField}` : "";

export function describeFeaturesFull(f: FeatureSchema, modules: ModuleRow[]): string[] {
  const out: string[] = [];
  if (f.view) {
    const v = f.view;
    out.push(
      v.type === "custom"
        ? `A screen written for it, “${v.title}”${said(v.html) ? `: ${said(v.html)}` : ""}`
        : `Shown as a ${v.type}${detailOf(v)}`
    );
  }
  for (const t of f.tabs ?? []) {
    out.push(
      t.type === "custom"
        ? `A tab written for it, “${t.title}”${said(t.html) ? `: ${said(t.html)}` : ""}`
        : `A tab “${tabName(t)}”, shown as ${t.type === "cards" ? "cards" : `a ${t.type}`}${detailOf(t)}`
    );
  }
  if (f.search?.enabled) {
    out.push(`Search${f.search.fields?.length ? ` over ${f.search.fields.join(", ")}` : ""}`);
  }
  for (const fl of f.filters ?? []) {
    out.push(`Filter by ${fl.label} (${fl.options.join(" / ")})`);
  }
  if (f.period) {
    const p = f.period;
    const days = presetsOf(p);
    const by = p.label?.trim() || p.field;
    const opens = openingPick(p);
    out.push(
      `Choose the dates by ${by}: the last ${days.slice(0, -1).join(", ")}${days.length > 1 ? " or " : ""}${days.at(-1)} days, their own dates, or all (opens on ${opens && "days" in opens ? `the last ${opens.days} days` : "all"})`
    );
  }
  for (const st of f.stats ?? []) {
    const what =
      st.op === "count"
        ? "count of rows"
        : `${st.op} of ${exprText(st.value ?? (st.field ? { field: st.field } : undefined))}`;
    const cond = st.where ? `, where ${exprText(st.where)}` : "";
    const grouped = st.by ? `, by ${st.by} (top ${st.limit ?? 5})` : "";
    out.push(`Stat “${st.label}” — ${what}${cond}${grouped}`);
  }
  if (f.defaultSort) out.push(`Sorted by ${f.defaultSort.field} ${f.defaultSort.dir}`);
  for (const a of f.actions ?? []) {
    const sets = Object.entries(a.set)
      .map(([k, v]) => `${k} = ${exprText(v)}`)
      .join(", ");
    const when = a.when ? `, shown when ${exprText(a.when)}` : "";
    out.push(`Button “${a.label}” — sets ${sets}${when}`);
  }
  if (f.scanMode) {
    const sets = Object.entries(f.scanMode.action.set)
      .map(([k, v]) => `${k} = ${exprText(v)}`)
      .join(", ");
    const matches = [f.scanMode.lookupField, ...(f.scanMode.alsoMatch ?? [])].join(" or ");
    out.push(
      (f.scanMode.first ? `Scan bar: first a ${f.scanMode.first.field} opens its rows, then ` : "Scan bar on ") +
        `${matches} — “${f.scanMode.action.label}” sets ${sets}` +
        (f.scanMode.sequenceField ? `, in ${f.scanMode.sequenceField} order` : "") +
        (f.scanMode.done
          ? `; when every open row has ${exprText(f.scanMode.done)}, it is done and the bar goes back to the first scan`
          : "")
    );
  }
  void modules;
  return out;
}

export interface PlanSummary {
  title: string;
  lines: string[];
  /** Things true of this plan that the owner should see before saying yes. */
  warnings?: string[];
}

/** A connected store, as far as overlap checking is concerned. */
export type StoreFacts = {
  shop_domain: string;
  currency: string;
  counts: Record<string, number>;
};

/**
 * Which Shopify table a section would sit beside.
 *
 * Matched on the words a merchant actually types rather than on table
 * names, because they ask for "Stock" and mean inventory levels.
 */
const STORE_TOPICS: Array<{ table: string; words: RegExp; noun: string }> = [
  {
    table: "fulfillments",
    words: /\bshipments?\b|\btracking\b|\bcouriers?\b|\bdelivery partners?\b|\bfulfil+ments?\b|\bdispatch(ed|es)?\b/i,
    noun: "shipments",
  },
  // Most specific first. "Order Items" names the order lines, and
  // matched "orders" while this list began with them.
  { table: "order_line_items", words: /\border (line )?items?\b|\bline items?\b/i, noun: "order lines" },
  // Sales per product are a view over the order lines, so the count
  // that says "you already have these" is the lines'.
  {
    table: "order_line_items",
    words: /\bbest.?sellers?\b|\btop (selling )?products?\b|\bproduct sales\b|\bsales by product\b|\bunits sold\b/i,
    noun: "product sales",
  },
  // A list of SKUs is the order lines or the variants; either way the
  // store has it.
  { table: "order_line_items", words: /\bskus?\b/i, noun: "order lines" },
  { table: "refunds", words: /\brefund(s|ed)?\b|\breturns?\b/i, noun: "refunds" },
  { table: "variants", words: /\bvariants?\b|\bbarcodes?\b|\bprice list\b/i, noun: "variants" },
  { table: "orders", words: /\border(s)?\b|\bsales?\b/i, noun: "orders" },
  { table: "customers", words: /\bcustomer(s)?\b|\bbuyer(s)?\b|\bclient(s)?\b/i, noun: "customers" },
  {
    table: "products",
    words: /\bproduct(s)?\b|\bcatalogue\b|\bcatalog\b|\bitem(s)?\b/i,
    noun: "products",
  },
  { table: "inventory_levels", words: /\bstock\b|\binventory\b/i, noun: "stock levels" },
];

/**
 * Says when a new section would duplicate data the store already holds.
 *
 * Deliberately a warning on the approval card, not a rejection sent
 * back to the model. Whether to keep a hand-kept list beside the
 * Shopify one is the merchant's call — plenty of them track something
 * Shopify does not. A gate here would refuse a design they are entitled
 * to ask for, and burn repair attempts arguing about it.
 */
export function storeOverlap(plan: AssistantPlan, store: StoreFacts | null): string[] {
  if (!store || plan.changeType !== "NEW_MODULE") return [];
  // Nothing to warn about when the section IS the store's list rather
  // than a second copy of it.
  if (plan.newModule?.source_table) return [];

  const name = `${plan.newModule?.nav_label ?? ""} ${plan.newModule?.name ?? ""}`.trim();
  if (!name) return [];

  const hit = STORE_TOPICS.find((t) => t.words.test(name) && (store.counts[t.table] ?? 0) > 0);
  if (!hit) return [];

  return [
    `${store.shop_domain} already has ${store.counts[hit.table]} ${hit.noun} in this project. ` +
      `This builds a separate section you would fill in yourself — the two lists will not match each other. A section over your ${hit.noun} can hold fields of yours beside each one instead.`,
  ];
}

const VIEW_NAMES: Record<string, string> = {
  table: "table",
  board: "board",
  calendar: "calendar",
  cards: "cards",
  list: "list",
};
const viewName = (v: ViewSpec | null | undefined) =>
  !v ? "table" : v.type === "custom" ? `screen “${v.title}”` : (VIEW_NAMES[v.type] ?? "table");

/**
 * A section's first view is one, so a plan that sends one replaces
 * whatever was there: asked for a range of days, Luke wrote a screen and
 * Orders lost its table, and the card said only "a screen written for
 * it". Said here, from the plan, above the detail: what goes and what
 * stays. Known view, any change of kind; unknown (a section not open), a
 * written screen, which replaces whatever was there. Tabs are laid
 * beside it and take nothing away, but a change to them replaces the
 * whole row of them: a tab it leaves out goes, and the card says which.
 */
function viewReplaced(plan: AssistantPlan, modules: ModuleRow[], current?: FeatureSchema | null): string[] {
  if (plan.changeType !== "FEATURE_UPDATE" || !plan.targetModuleId) return [];
  const mod = modules.find((m) => m.id === plan.targetModuleId);
  const name = mod?.nav_label || mod?.name || "This section";
  const out: string[] = [];
  const next = plan.features?.view;
  if (next !== undefined) {
    const now = next === null ? "table" : viewName(next);
    const was = current === undefined ? null : viewName(current?.view);
    // The same view, or the same screen rewritten: nothing goes.
    if (was !== now && (was !== null || next?.type === "custom")) {
      const shows = next?.type === "custom" ? `the ${now} written for it` : now === "cards" ? "cards" : `a ${now}`;
      out.push(
        `${name} will show ${shows} in place of its ${was ?? "current view"}. Its rows stay; Put it back, once it is built, brings the ${was ?? "view"} back.`
      );
    }
  }
  const tabs = plan.features?.tabs;
  if (tabs !== undefined && current !== undefined) {
    const kept = new Set((tabs ?? []).map((t) => tabName(t).toLowerCase()));
    for (const t of current?.tabs ?? []) {
      if (!kept.has(tabName(t).toLowerCase())) {
        out.push(
          `${name} will lose its tab “${tabName(t)}”. Its rows stay; Put it back, once it is built, brings the tab back.`
        );
      }
    }
  }
  return out;
}

/**
 * A plan in the owner's card. A field add carries the section's columns
 * with the new ones after them, and describePlan names them all; the card
 * names the new ones. A written screen is in the preview beside it, so its
 * words are not read out again. The critic and the gap pass still read
 * describePlan's words, which their recordings hold.
 * ponytail: give them the same, with one fill-in recording of the checks that add a field.
 */
export function describeForOwner(
  plan: AssistantPlan,
  modules: ModuleRow[],
  currentColumns?: Array<{ field: string; label: string }>,
  store?: StoreFacts | null,
  currentFeatures?: FeatureSchema | null
): ReturnType<typeof describePlan> {
  const d = describePlan(plan, modules, currentColumns, store, currentFeatures);
  const view = plan.features?.view;
  // A written screen is in the preview: its title here, not its words again.
  const screens = [
    ...(view?.type === "custom" ? [`A screen written for it, “${view.title}”`] : []),
    ...(plan.features?.tabs ?? [])
      .filter((t) => t.type === "custom")
      .map((t) => `A tab written for it, “${tabName(t)}”`),
  ];
  let lines = d.lines.map((l) => screens.find((sc) => l.startsWith(sc)) ?? l);
  if (plan.changeType === "FIELD_ADD" && currentColumns) {
    const had = new Set(currentColumns.map((c) => c.field));
    const added = (plan.newSchema?.columns ?? []).filter((c) => !had.has(c.field));
    lines = [`New: ${added.map((c) => c.label).join(", ")}`, ...lines.slice(1)];
  }
  return { ...d, lines };
}

/**
 * Describes a plan from the plan itself, never from the sentence the
 * assistant wrote next to it. A generated description cannot promise
 * something the plan does not do.
 */
export function describePlan(
  plan: AssistantPlan,
  modules: ModuleRow[],
  /** The section's columns today, so a plan that adds some says so. */
  currentColumns?: Array<{ field: string; label: string }>,
  /** The connected store, if there is one, for the overlap warning. */
  store?: StoreFacts | null,
  /** The section's features today (null: none, so its table), when known, so a plan that replaces a view or a tab says what goes. */
  currentFeatures?: FeatureSchema | null
): PlanSummary {
  const warnings = [...storeOverlap(plan, store ?? null), ...viewReplaced(plan, modules, currentFeatures)];
  const withWarnings = (s: PlanSummary): PlanSummary => (warnings.length ? { ...s, warnings } : s);
  return withWarnings(describePlanBody(plan, modules, currentColumns));
}

function describePlanBody(
  plan: AssistantPlan,
  modules: ModuleRow[],
  currentColumns?: Array<{ field: string; label: string }>
): PlanSummary {
  const target = modules.find((m) => m.id === plan.targetModuleId);
  const targetName = plan.targetModuleId?.startsWith("#")
    ? plan.targetModuleId.slice(1)
    : (target?.nav_label ?? "this section");

  switch (plan.changeType) {
    case "NEW_MODULE": {
      const lines: string[] = [];
      const cols = plan.newSchema?.columns ?? [];
      // Where the rows come from is the first thing worth knowing: a
      // section over the store always matches Shopify, and one they
      // fill in themselves never will.
      const src = plan.newModule?.source_table;
      const theirs = isStoreTable(src) ? new Set(storeTableSchema(src).columns.map((c) => c.field)) : null;
      if (src) {
        lines.push(
          `Rows come from your ${src.replace("_", " ")} synced from Shopify — always the same list, and its own fields stay as Shopify has them`
        );
      }
      // A computed column is not a field anybody fills in, and the
      // merchant approving this is the one person who would otherwise
      // find that out by trying to type in it. On a section over the
      // store, what they fill in is kept beside each of its rows.
      if (cols.length) {
        const typed = cols.filter((c) => !c.compute && !theirs?.has(c.field));
        const worked = cols.filter((c) => c.compute);
        if (typed.length) {
          lines.push(
            theirs
              ? `Yours to fill in beside each row: ${typed.map((c) => c.label).join(", ")}`
              : `Fields: ${typed.map((c) => c.label).join(", ")}`
          );
        }
        if (worked.length) {
          lines.push(
            `Worked out for you, not typed: ${worked.map((c) => c.label).join(", ")} — kept right on its own, every time you open it`
          );
        }
      }
      if (plan.features) lines.push(...describeFeaturesFull(plan.features, modules));
      if (plan.newRecords?.length) lines.push(`${plan.newRecords.length} example rows to start with`);
      return { title: `New section: ${plan.newModule?.nav_label ?? plan.newModule?.name ?? "—"}`, lines };
    }
    case "FIELD_ADD": {
      const existing = new Set<string>();
      const added = (plan.newSchema?.columns ?? []).filter((c) => !existing.has(c.field));
      return {
        title: `Add fields to ${targetName}`,
        lines: [`New: ${added.map((c) => c.label).join(", ")}`],
      };
    }
    case "UI_CHANGE": {
      // The assistant sometimes labels a column-adding plan UI_CHANGE.
      // It applies correctly either way, but the card must describe
      // what the plan does, not which name was put on it.
      const cols = plan.newSchema?.columns ?? [];
      const known = new Set((currentColumns ?? []).map((c) => c.field));
      const added = currentColumns ? cols.filter((c) => !known.has(c.field)) : [];
      return {
        title: added.length > 0 ? `Add fields to ${targetName}` : `Rearrange ${targetName}`,
        lines: [
          ...(added.length > 0 ? [`New: ${added.map((c) => c.label).join(", ")}`] : []),
          `Columns in order: ${cols.map((c) => c.label).join(", ")}`,
        ],
      };
    }
    case "MODULE_UPDATE": {
      const u = plan.moduleUpdate ?? {};
      const lines: string[] = [];
      if (u.nav_label) lines.push(`Rename to “${u.nav_label}”`);
      if (u.icon) lines.push(`Change its icon`);
      if (u.sort_order !== undefined) lines.push(`Move it in the sidebar`);
      return { title: `Update ${targetName}`, lines };
    }
    case "MODULE_DELETE":
      return { title: `Delete ${targetName}`, lines: ["Removes the section and every row in it"] };
    case "FEATURE_UPDATE":
      return {
        title: `Change how ${targetName} works`,
        lines: plan.features ? describeFeaturesFull(plan.features, modules) : [],
      };
    case "RECORD_SEED":
      return {
        title: `Add rows to ${targetName}`,
        lines: [`${plan.newRecords?.length ?? 0} rows`],
      };
    case "AUTOMATION_ADD":
      return {
        title: `Rule: ${plan.automation?.name ?? "—"}`,
        lines: plan.automation ? describeAutomation(plan.automation, modules) : [],
      };
    case "AUTOMATION_REMOVE":
      return { title: `Turn off rule “${plan.automationRemoveName}”`, lines: [] };
    default:
      return { title: plan.changeType, lines: [] };
  }
}

// ── What a connected assistant asked for ────────────────────────
//
// Luke reads the app's structure fresh every turn, so a section the
// owner's Claude built is visible to it — but not why, or that it was
// their Claude that asked. These lines carry that: the request, whether
// it was built, what failed, what has since gone. One line each, newest
// first, and short: five of them are a paragraph, not a page.

/** A build request row, as the prompt needs to read it. */
export type RequestRow = {
  id: string;
  request: string;
  status: string;
  summary: string | null;
  plans: AssistantPlan[] | null;
  outcome: { applied?: Array<{ changeType?: string; moduleId?: string }>; errors?: string[] } | null;
  client_id: string | null;
  created_at: string;
  built_at: string | null;
};

/**
 * The words on the buttons a waiting design is finished with.
 *
 * Defined once and read in two places: the panel puts them on the
 * buttons, and the answer a connected assistant reads out quotes
 * them. They used to exist only as JSX, so every instruction about
 * them was a second copy nobody would think to change — and an
 * assistant telling a merchant to tap something that no longer says
 * that is worse than saying nothing.
 */
export const WAITING_BUTTONS = {
  build: "Build it",
  openRemoval: "Remove a section…",
  confirmRemoval: "Remove it",
  /** A change to the shop itself, which is a different kind of yes. */
  runStoreAction: "Do it",
} as const;

/**
 * What the merchant actually does, in order, to finish this one.
 *
 * Every answer about a waiting design used to be written for the
 * model — "tell them it is waiting in Warmluke" — so the best a
 * connected assistant could relay was that something, somewhere,
 * needed them. This is the other half: the link that opens on it,
 * and the taps, in the words that are really on the buttons.
 *
 * Derived from the row, never from the kind of request it was: a
 * removal earns two more steps because its plans say so, not
 * because removals were special-cased here. Anything already
 * settled returns nothing, so a caller cannot invent work that is
 * not waiting.
 */
export function stepsToFinish(
  r: Pick<RequestRow, "status" | "plans"> & { approved_at?: string | null },
  link: string
): string[] {
  const settled = r.status === "built" || r.status === "dismissed" || r.status === "opened";
  if (settled) return [];
  const open = `Open ${link} — it opens with this in front of them`;
  if (r.status === "building") {
    return [`${open}. It is being applied now; nothing to tap.`];
  }
  if (r.status === "partly_built") {
    return [
      open,
      "The card says which part did not build.",
      "Ask for that part again as a new request — this one cannot be finished.",
    ];
  }
  const gone = (r.plans ?? [])
    .filter((p) => p.changeType === "MODULE_DELETE")
    .map((p) => p.deleteConfirmName)
    .filter((n): n is string => !!n);
  return gone.length
    ? [
        open,
        `Tap "${WAITING_BUTTONS.openRemoval}"`,
        `Type exactly: ${gone.join(", ")}`,
        `Tap "${WAITING_BUTTONS.confirmRemoval}"`,
      ]
    : [open, `Tap "${WAITING_BUTTONS.build}"`];
}

/**
 * What the merchant does to finish a change to their shop.
 *
 * The sibling of stepsToFinish, and deliberately a second function
 * rather than a flag on the first: a design waits for a build inside
 * Warmluke, and this waits to go out to a live Shopify store. They
 * look alike on the card and are not the same promise, and a
 * function that blurred them would be the place that stopped saying
 * which one a merchant was agreeing to.
 *
 * The confirm level comes off the registry entry, so an action that
 * one day needs a word typed gets that step here without this
 * function learning its name.
 */
export function stepsToFinishAction(
  row: { status: string; action: string },
  link: string,
  spec: { label: string; confirm: "list" | "typed" } | null
): string[] {
  const settled =
    row.status === "done" || row.status === "partly_done" || row.status === "failed" || row.status === "dismissed";
  if (settled) return [];
  const open = `Open ${link} — it opens with this in front of them`;
  if (row.status === "running") {
    return [`${open}. It is being sent to the shop now; nothing to tap.`];
  }
  if (row.status === "approved") {
    return [`${open}. They have already agreed to it; it runs by itself.`];
  }
  // An action nobody declared cannot be described, and saying "tap
  // Do it" about one would be inventing a button for a change that
  // will refuse itself the moment it runs.
  if (!spec) {
    return [open, "Warmluke does not recognise this change, so it cannot be done."];
  }
  return spec.confirm === "typed"
    ? [open, "Type the word it asks for", `Tap "${WAITING_BUTTONS.runStoreAction}"`]
    : [open, `Tap "${WAITING_BUTTONS.runStoreAction}"`];
}

/** How much of a request is quoted. Enough to recognise it by. */
const REQUEST_CHARS = 160;

/** "3 minutes ago", "2 hours ago", "4 days ago" — the thread has no calendar. */
function ago(iso: string, now: Date): string {
  const minutes = Math.round(Math.max(0, now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function describeRequests(rows: RequestRow[], modules: ModuleRow[], now = new Date()): string[] {
  return rows.map((r) => {
    const asked = (r.request ?? "").replace(/\s+/g, " ").trim();
    const quote = asked.length > REQUEST_CHARS ? `${asked.slice(0, REQUEST_CHARS - 1)}…` : asked;
    const via = r.client_id ? ` via ${r.client_id}` : "";
    const plans = Array.isArray(r.plans) ? r.plans : [];
    const titles = plans.map((p) => describePlan(p, modules).title);
    const applied = r.outcome?.applied ?? [];
    const errors = r.outcome?.errors ?? [];
    // A section it created that is not here any more was put back, or
    // deleted, since. Said, so "that section" is not described as live.
    const gone = plans
      .filter((p) => p.changeType === "NEW_MODULE" && p.newModule && !modules.some((m) => m.name === p.newModule!.name))
      .map((p) => p.newModule!.nav_label);

    switch (r.status) {
      case "built":
      case "partly_built": {
        const head = `${r.status === "built" ? "built" : "partly built"} ${ago(r.built_at ?? r.created_at, now)}${via}: "${quote}"`;
        // Plans apply in order, so what landed is the first however-many.
        const done = titles.slice(0, applied.length || titles.length);
        const parts: string[] = [];
        if (done.length) parts.push(`built: ${done.join("; ")}`);
        if (errors.length)
          parts.push(`did not build ${errors.length} of ${plans.length || errors.length}: ${errors[0].slice(0, 120)}`);
        if (gone.length) parts.push(`since removed: ${gone.join(", ")}`);
        return parts.length ? `${head} → ${parts.join(" · ")}` : head;
      }
      case "pending":
        return `pending ${ago(r.created_at, now)}${via} — not built, waiting for the owner's yes: "${quote}"${titles.length ? ` (would: ${titles.join("; ")})` : ""}`;
      case "opened":
        return `opened in Luke ${ago(r.created_at, now)}${via} — being designed here, not built: "${quote}"`;
      case "building":
        return `building now${via}: "${quote}"`;
      case "dismissed":
        return `dismissed ${ago(r.created_at, now)}${via} — turned down, not built: "${quote}"`;
      default:
        return `${r.status} ${ago(r.created_at, now)}${via}: "${quote}"`;
    }
  });
}

/** The store list a list of its own retypes: its key and one more of its columns, or any three. */
function retypedList(p: AssistantPlan): { table: string; shared: string[] } | null {
  if (p.changeType !== "NEW_MODULE" || !p.newModule || p.newModule.source_table) return null;
  const typed = new Set(
    (p.newSchema?.columns ?? []).filter((c) => c && !c.compute && typeof c.field === "string").map((c) => c.field)
  );
  let best: { table: string; shared: string[] } | null = null;
  for (const [table, spec] of Object.entries(STORE_TABLES)) {
    const shared = spec.columns.map((c) => c.field).filter((f) => typed.has(f));
    const keyed = shared.includes(spec.columns[0]?.field);
    if (shared.length < 3 && !(keyed && shared.length >= 2)) continue;
    // The first of the most: the registry lists a list before the
    // ones that repeat its key (orders before their refunds).
    if (!best || shared.length > best.shared.length) best = { table, shared };
  }
  return best;
}

const nounOf = (table: string) =>
  STORE_TABLES[table as keyof typeof STORE_TABLES]?.section.label.toLowerCase() ?? table.replace(/_/g, " ");

/**
 * A list of its own that types in what a store list already holds.
 *
 * A section over the store carries the merchant's fields beside each
 * row (0128), so a second list of the same orders, filled in by hand,
 * has nothing left to offer, and never matches the real ones. Read
 * from the registry (retypedList). Said to a connected assistant as a
 * heads-up; in the chat it is a question for the owner (reuseQuestion).
 */
export function retypedCopies(plans: AssistantPlan[], store: StoreFacts | null): string[] {
  if (!store) return [];
  return plans.flatMap((p) => {
    const hit = retypedList(p);
    if (!hit || !p.newModule) return [];
    return [
      `"${p.newModule.nav_label}" types in what the store's ${nounOf(hit.table)} already hold (${hit.shared.join(", ")}): a second list of them, filled in by hand, that never matches the real ones. Build it over the store's list instead — NEW_MODULE with "source_table": "${hit.table}" — and put what the work needs beside each row as fields of theirs, unless it tracks something the store does not have.`,
    ];
  });
}

/**
 * A new section that works on rows a section of theirs already works on.
 *
 * The same store list under a second section, or a list of their own
 * with three of another's fields (half, for a small one): the work may
 * belong in the
 * one they have. Whether it does is theirs to say, and a model that
 * knows the answer is uncertain rarely asks, so it is asked here, by
 * the code, in one tap. The rows are never copied either way.
 */
export function sectionTwin(
  p: AssistantPlan,
  modules: ModuleRow[],
  columnsOf: (id: string) => Array<{ field: string; compute?: unknown }> | undefined
): ModuleRow | null {
  if (p.changeType !== "NEW_MODULE" || !p.newModule) return null;
  const src = p.newModule.source_table ?? null;
  if (src) return modules.find((m) => m.source_table === src) ?? null;
  const typed = new Set((p.newSchema?.columns ?? []).filter((c) => c && !c.compute).map((c) => c.field));
  // Three shared fields, or half of a small list's own: two of three is
  // the same list as surely as three of eight.
  const enough = Math.max(2, Math.min(3, Math.ceil(typed.size / 2)));
  return (
    modules.find(
      (m) => !m.source_table && (columnsOf(m.id) ?? []).filter((c) => !c.compute && typed.has(c.field)).length >= enough
    ) ?? null
  );
}

/**
 * The one question a design waits on before it is drawn: where the work
 * goes, when a section of theirs, or a store list, already holds the
 * rows it works on. Null when nothing overlaps, or when this thread has
 * asked it already (`asked`), so an answer is never asked again.
 */
export function reuseQuestion(
  plans: AssistantPlan[],
  modules: ModuleRow[],
  columnsOf: (id: string) => Array<{ field: string; compute?: unknown }> | undefined,
  store: StoreFacts | null,
  asked: (key: string) => boolean
): { type: "clarify"; message: string; questions: ClarifyQuestion[] } | null {
  const one = (q: ClarifyQuestion) => ({
    type: "clarify" as const,
    message: "One thing before I design it.",
    questions: [q],
  });
  for (const p of plans) {
    const twin = sectionTwin(p, modules, columnsOf);
    if (twin && !asked(`reuse-${twin.id}`) && !asked(twin.nav_label)) {
      const src = p.newModule?.source_table;
      const rows = src ? `your ${nounOf(src)}` : "the same rows";
      // One section is the default the design rules keep to, so adding
      // is the pick; the model, when it asks, weighs the actual work.
      const add = `Yes: add it to ${twin.nav_label}, one screen for both`;
      return one({
        id: `reuse-${twin.id}`,
        question: `“${twin.nav_label}” already works on ${rows}. Add this to it?`,
        suggestions: [
          add,
          src
            ? `No: a separate section over the same ${nounOf(src)}; ${twin.nav_label} stays as it is`
            : `No: a separate list, filled in on its own`,
        ],
        recommended: add,
        why: `My pick: add it to ${twin.nav_label}. It works on ${rows} already, so the work stays in one place.`,
      });
    }
    const copy = store ? retypedList(p) : null;
    if (copy && !asked(`reuse-store-${copy.table}`)) {
      const noun = nounOf(copy.table);
      const build = `Yes: build it on my ${noun}, always matching Shopify`;
      return one({
        id: `reuse-store-${copy.table}`,
        question: `This would be a second list of your ${noun}, typed in by hand. Build it on your store's ${noun} instead?`,
        suggestions: [build, `No: keep a separate list, typed in by hand`],
        recommended: build,
        why: `My pick: build it on your ${noun}. What you fill in sits beside each one, and a list typed in by hand drifts from the real ones.`,
      });
    }
  }
  return null;
}

/**
 * Rows made up beside the store's own.
 *
 * storeOverlap warns and lets the section through: a hand-kept list
 * next to the Shopify one is the merchant's call. Filling that list
 * with rows nobody typed is not — a connected assistant seeded four
 * "example" order lines it had invented, and they sat beside the real
 * orders looking like data. So the section may stand; the made-up
 * rows may not. Said back with that first: told "build it over the
 * store's list instead" first, a design for logging returns moved onto
 * the store's returns, which no one can add a return to (4 Oct).
 */
/** Whether a new section keeps any of the fields of the store list its name points at. */
function keepsStoreFields(p: AssistantPlan): boolean {
  const name = `${p.newModule?.nav_label ?? ""} ${p.newModule?.name ?? ""}`;
  const topic = STORE_TOPICS.find((t) => t.words.test(name));
  const theirs = topic && isStoreTable(topic.table) ? STORE_TABLES[topic.table].columns : [];
  const norm = (s: unknown) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const mine = new Set((p.newSchema?.columns ?? []).flatMap((c) => [norm(c.field), norm(c.label)]));
  return theirs.some((c) => mine.has(norm(c.field)) || mine.has(norm(c.label)));
}

export function seededCopies(plans: AssistantPlan[], store: StoreFacts | null): string[] {
  if (!store) return [];
  const out: string[] = [];
  for (const p of plans) {
    if (p.changeType !== "NEW_MODULE" || !p.newModule || p.newModule.source_table) continue;
    const overlap = storeOverlap(p, store);
    if (!overlap.length) continue;
    // A copy is known by its fields, not its name: "Courier Rates" says
    // courier and holds a rate card, nothing of the shipments' own. Only
    // a section that keeps some of the store list's own fields is one.
    if (!keepsStoreFields(p)) continue;
    const seededHere =
      (p.newRecords?.length ?? 0) > 0 ||
      plans.some(
        (q) =>
          q.changeType === "RECORD_SEED" &&
          q.targetModuleId === `#${p.newModule!.name}` &&
          (q.newRecords?.length ?? 0) > 0
      );
    if (!seededHere) continue;
    out.push(
      `"${p.newModule.nav_label}" would be filled with rows you made up, beside the store's own. ${overlap[0]} Send newRecords as null and keep the section for the owner to fill. Only if they want to see the store's own rows rather than add their own, build it over that list instead (set "source_table").`
    );
  }
  return out;
}
