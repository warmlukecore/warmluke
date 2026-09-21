// ─────────────────────────────────────────────────────────────
// Turns an expression tree back into a sentence. The owner approves
// and audits rules they never wrote in JSON, so this is the only
// form of them they ever see.
// ─────────────────────────────────────────────────────────────

import type {
  AssistantPlan,
  AutomationDefinition,
  Expr,
  FeatureSchema,
  ModuleRow,
} from "./types";

/** Renders an expression tree as something a non-technical owner reads. */
export function exprText(e: Expr | undefined): string {
  if (!e) return "";
  if ("const" in e) return String(e.const);
  if ("field" in e) return e.field;
  if ("was" in e) return `previous ${e.was}`;
  if ("target" in e) return `their ${e.target}`;

  const a = (e.args ?? []).map(exprText);
  switch (e.op) {
    case "and": return a.join(" and ");
    case "or": return a.join(" or ");
    case "not": return `not ${a[0]}`;
    case "=": return `${a[0]} is ${a[1]}`;
    case "!=": return `${a[0]} is not ${a[1]}`;
    case ">": return `${a[0]} is more than ${a[1]}`;
    case ">=": return `${a[0]} is at least ${a[1]}`;
    case "<": return `${a[0]} is less than ${a[1]}`;
    case "<=": return `${a[0]} is at most ${a[1]}`;
    case "contains": return `${a[0]} contains “${a[1]}”`;
    case "starts_with": return `${a[0]} starts with “${a[1]}”`;
    case "is_empty": return `${a[0]} is blank`;
    case "is_set": return `${a[0]} is filled in`;
    case "changed": return `${a[0]} just changed`;
    case "days_since": return `days since ${a[0]}`;
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
    case "if":
      return `${a[1]} if ${a[0]}, otherwise ${a[2] ?? "nothing"}`;
    case "round": return `rounded ${a[0]}`;
    case "today": return "today";
    case "now": return "right now";
    case "+": return a.join(" plus ");
    case "-": return a.join(" minus ");
    case "*": return a.join(" times ");
    case "/": return a.join(" divided by ");
    case "concat": return a.join(" + ");
    default: return a.join(` ${e.op} `);
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

/**
 * The rules already running, in the words the approval card uses.
 *
 * Nothing told the designer these existed. Not the chat box, not a
 * connected assistant — so both would answer "there is no such rule"
 * about a rule that runs every day, or propose a second one beside it.
 * A designer that cannot see what is there designs over the top of it.
 */
export function describeRules(
  rules: RuleRow[],
  modules: Array<{ id: string; nav_label: string }>
): string[] {
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
  } else if (t?.type === "schedule") {
    const every = t.every ?? "daily";
    out.push(cond ? `${every[0].toUpperCase()}${every.slice(1)}, for rows where ${cond}` : `${every}`);
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
    } else if (a.type === "webhook") {
      out.push("→ call an external service");
    }
  }
  return out;
}



// ── Plans ────────────────────────────────────────────────────

/** Every feature a plan configures, stated from the config itself. */
export function describeFeaturesFull(f: FeatureSchema, modules: ModuleRow[]): string[] {
  const out: string[] = [];
  if (f.view) {
    const v = f.view;
    const detail =
      v.type === "board"
        ? ` grouped by ${v.groupBy}`
        : v.type === "calendar"
          ? ` by ${v.dateField}`
          : "";
    out.push(`Shown as a ${v.type}${detail}`);
  }
  if (f.search?.enabled) {
    out.push(`Search${f.search.fields?.length ? ` over ${f.search.fields.join(", ")}` : ""}`);
  }
  for (const fl of f.filters ?? []) {
    out.push(`Filter by ${fl.label} (${fl.options.join(" / ")})`);
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
    out.push(
      `Scan bar on ${f.scanMode.lookupField} — “${f.scanMode.action.label}” sets ${sets}` +
        (f.scanMode.sequenceField ? `, in ${f.scanMode.sequenceField} order` : "")
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
  { table: "fulfillments", words: /\bshipments?\b|\btracking\b|\bcouriers?\b|\bdelivery partners?\b|\bfulfil+ments?\b|\bdispatch(ed|es)?\b/i, noun: "shipments" },
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
      `This builds a separate section you would fill in yourself — the two lists will not match each other.`,
  ];
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
  store?: StoreFacts | null
): PlanSummary {
  const warnings = storeOverlap(plan, store ?? null);
  const withWarnings = (s: PlanSummary): PlanSummary =>
    warnings.length ? { ...s, warnings } : s;
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
      // section over the store is read-only and always matches
      // Shopify, and one they fill in themselves never will.
      const src = plan.newModule?.source_table;
      if (src) {
        lines.push(
          `Rows come from your ${src.replace("_", " ")} synced from Shopify — read-only, always the same list`
        );
      }
      // A computed column is not a field anybody fills in, and the
      // merchant approving this is the one person who would otherwise
      // find that out by trying to type in it.
      if (cols.length) {
        const typed = cols.filter((c) => !c.compute);
        const worked = cols.filter((c) => c.compute);
        if (typed.length) lines.push(`Fields: ${typed.map((c) => c.label).join(", ")}`);
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
        if (errors.length) parts.push(`did not build ${errors.length} of ${plans.length || errors.length}: ${errors[0].slice(0, 120)}`);
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

/**
 * Rows made up beside the store's own.
 *
 * storeOverlap warns and lets the section through: a hand-kept list
 * next to the Shopify one is the merchant's call. Filling that list
 * with rows nobody typed is not — a connected assistant seeded four
 * "example" order lines it had invented, and they sat beside the real
 * orders looking like data. So the section may stand; the made-up
 * rows may not. Said back with the list to build over instead.
 */
export function seededCopies(plans: AssistantPlan[], store: StoreFacts | null): string[] {
  if (!store) return [];
  const out: string[] = [];
  for (const p of plans) {
    if (p.changeType !== "NEW_MODULE" || !p.newModule || p.newModule.source_table) continue;
    const overlap = storeOverlap(p, store);
    if (!overlap.length) continue;
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
      `"${p.newModule.nav_label}" would be filled with rows you made up, beside the store's own. ${overlap[0]} Build it over the store's list instead — set "source_table" and send newRecords as null — or leave it empty for the owner to fill.`
    );
  }
  return out;
}
