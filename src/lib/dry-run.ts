// A rule of a design, run in the head before it is built: its condition
// over the rows it would meet, so the owner reads "would change 2,353 of
// 2,353 shipments" or "23 of 412 orders match" on the design's card
// before the rule has written anything. A rule that writes "No" into
// every row every hour looks like any other rule on paper; counted, it
// does not.
//
// No model and no write. The rows are read on the caller's own client,
// so RLS decides what may be counted, and the expressions are worked out
// by lib/expr, the runtime's own twin of the database's evaluator: a
// blank reads as the runtime reads it, never as this file guesses.
//
// The section reader here is the data check's too (lib/data-check.ts).
//
// Callers: src/lib/review-gate.ts, src/lib/data-check.ts.

import { isOperator, isServerOnly } from "@/lib/capabilities";
import { evalExpr, truthy, withComputed } from "@/lib/expr";
import { findSection } from "@/lib/section-ref";
import { STORE_TABLES, isStoreTable, storeSectionColumns, type StoreTable } from "@/lib/store-read";
import type { AssistantPlan, ModuleRow, SchemaColumn } from "@/lib/types";
import type { DryRun, ReviewContext } from "@/lib/review-types";

export type Row = Record<string, unknown>;

/** The most rows a check reads of one section, newest first. ponytail: a bigger list is told on its newest 2,000, and says so. */
export const ROWS_READ = 2000;
/** How long a check may take; past it, what it found so far. */
export const BUDGET_MS = 5000;
/** A store list comes a page at a time: abo_store_page gives 200 at most. */
const STORE_PAGE = 200;
/** And a section of the owner's own a thousand, which is what PostgREST hands back in one read. */
const OWN_PAGE = 1000;
/** Touching every row means something only past a handful of them. */
const EVERY_ROW_AT = 20;

/** A value as the runtime reads it for comparing: blank for nothing, else its text. */
export const txt = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** A count, written the way the owner writes numbers. */
export function count(n: number, locale: string): string {
  try {
    return n.toLocaleString(locale);
  } catch {
    return n.toLocaleString("en");
  }
}

/** Every node of an expression, itself first. */
export function nodes(e: unknown): Row[] {
  if (!e || typeof e !== "object") return [];
  const n = e as Row;
  return [n, ...(Array.isArray(n.args) ? n.args.flatMap(nodes) : [])];
}

// ── The section a design points at ───────────────────────────

/** A section that is there, as the design leaves it. */
export type Section = {
  mod: ModuleRow;
  /** As the sidebar names it. */
  name: string;
  table: StoreTable | null;
  /** Its columns once the design is built. */
  columns: SchemaColumn[];
  /** The fields this design adds, which no row can have yet. */
  fresh: Set<string>;
};

/**
 * The section `ref` means (an id or a "#slug"): one that is there, one
 * this design makes ({ made }, which has no rows yet), or null.
 */
export function sectionFor(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  ref: string | null | undefined
): Section | { made: string } | null {
  if (!ref) return null;
  const mod = findSection(ctx.modules, ref);
  if (!mod) {
    const made = plans.find(
      (p) =>
        p.changeType === "NEW_MODULE" &&
        p.newModule &&
        findSection([{ id: "", name: p.newModule.name, nav_label: p.newModule.nav_label }], ref)
    )?.newModule;
    return made ? { made: made.nav_label || made.name } : null;
  }
  const table = isStoreTable(mod.source_table) ? mod.source_table : null;
  const shape = (saved: SchemaColumn[] | null | undefined) =>
    table ? storeSectionColumns(table, saved) : (saved ?? []).filter((c) => c && typeof c.field === "string");
  const now = shape(ctx.schemas.get(mod.id)?.columns);
  // The last change to its columns in this design is what they will be.
  const designed = plans.findLast(
    (p) =>
      (p.changeType === "UI_CHANGE" || p.changeType === "FIELD_ADD") &&
      p.targetModuleId &&
      findSection([mod], p.targetModuleId) &&
      Array.isArray(p.newSchema?.columns)
  )?.newSchema.columns;
  const columns = designed ? shape(designed) : now;
  const had = new Set(now.map((c) => c.field));
  return {
    mod,
    name: mod.nav_label || mod.name,
    table,
    columns,
    fresh: new Set(columns.map((c) => c.field).filter((f) => !had.has(f))),
  };
}

// ── Reading its rows ─────────────────────────────────────────

export type SectionRows = {
  /** The newest rows, at most ROWS_READ, with their worked-out columns filled in. */
  rows: Row[];
  /** Rows in the whole section. */
  total: number;
  /** What a person calls a row: an order number, a title, a name. Never a phone, an email or an address. */
  label: (row: Row) => string;
  /** A field's values over the whole store list, its fifty commonest (abo_store_page); none for a section of the owner's. */
  facets: Record<string, string[]>;
};

/** Words that say a field is about a person rather than the thing the row is. */
const PERSONAL = /phone|mobile|whats ?app|e-?mail|address|street|city|zip|postal|pin ?code|customer|contact|who/i;

/** The field a row is called by: the first plain text field that is not a person's. */
function labelField(at: Section): string | null {
  // Every handle a customer has is the customer.
  if (at.table === "customers") return null;
  return (
    at.columns.find((c) => c.type === "text" && !c.compute && !PERSONAL.test(`${c.field} ${c.label}`))?.field ?? null
  );
}

/**
 * A section's newest rows, on the caller's client. A section over the
 * store reads through abo_store_page, a page at a time: its rows come
 * with the owner's own fields laid under the store's, as the screen and
 * the rules' runner see them, and `facets` asks it for those fields'
 * values over the whole list. A section of the owner's reads `records`.
 * Throws on a refused read; the checks turn that into nothing found.
 */
export async function readSection(ctx: ReviewContext, at: Section, facets: string[] = []): Promise<SectionRows> {
  let raw: Row[] = [];
  let total = 0;
  let values: Record<string, string[]> = {};
  if (at.table) {
    const spec = STORE_TABLES[at.table];
    const order = spec.opens ?? spec.order;
    const page = (offset: number, asked: string[]) =>
      ctx.db.rpc("abo_store_page", {
        p_module: at.mod.id,
        p_query: {
          offset,
          limit: STORE_PAGE,
          order: { field: order.field, dir: order.ascending ? "asc" : "desc" },
          facets: asked,
        },
      });
    type Page = { rows?: Array<{ data?: Row }>; total?: number; facets?: Record<string, string[]> };
    const first = await page(0, facets);
    if (first.error) throw new Error(first.error.message);
    const got = (first.data ?? {}) as Page;
    total = Number(got.total) || 0;
    values = got.facets ?? {};
    const pages = [got];
    const rest: Array<ReturnType<typeof page>> = [];
    for (let offset = STORE_PAGE; offset < Math.min(total, ROWS_READ); offset += STORE_PAGE)
      rest.push(page(offset, []));
    for (const r of await Promise.all(rest)) {
      if (r.error) throw new Error(r.error.message);
      pages.push((r.data ?? {}) as Page);
    }
    raw = pages.flatMap((p) => (p.rows ?? []).map((r) => r.data ?? {}));
  } else {
    for (let from = 0; from < ROWS_READ; from += OWN_PAGE) {
      const {
        data,
        count: n,
        error,
      } = await ctx.db
        .from("records")
        .select("data", from === 0 ? { count: "exact" } : undefined)
        .eq("module_id", at.mod.id)
        .is("store_row_id", null)
        .order("created_at", { ascending: false })
        .range(from, Math.min(from + OWN_PAGE, ROWS_READ) - 1);
      if (error) throw new Error(error.message);
      if (from === 0) total = n ?? (data ?? []).length;
      raw.push(...(data ?? []).map((r) => ((r as { data?: Row }).data ?? {}) as Row));
      if (from + OWN_PAGE >= total) break;
    }
  }
  const handle = labelField(at);
  return {
    rows: raw.slice(0, ROWS_READ).map((d) => withComputed(at.columns, d)),
    total: Math.max(total, raw.length),
    label: (row) => (handle ? txt(row[handle]).trim().slice(0, 60) : ""),
    facets: values,
  };
}

/**
 * Runs a check inside the budget: what it found, what it had found when
 * the time ran out or the turn was stopped, or nothing when it failed.
 * Never throws: a check that cannot look says nothing rather than
 * stopping the design it was reading.
 */
export async function inBudget<T>(ctx: ReviewContext, work: (out: T[]) => Promise<void>): Promise<T[]> {
  if (ctx.signal?.aborted) return [];
  const out: T[] = [];
  let quit!: () => void;
  const stop = new Promise<void>((resolve) => (quit = resolve));
  const timer = setTimeout(quit, BUDGET_MS);
  ctx.signal?.addEventListener("abort", quit, { once: true });
  try {
    await Promise.race([work(out), stop]);
    return [...out];
  } catch (e) {
    console.error(`[review] ${e instanceof Error ? e.message : "a check failed"}`);
    return [];
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", quit);
  }
}

// ── The dry-run ──────────────────────────────────────────────

/**
 * Each rule the design adds or changes (AUTOMATION_ADD), tried on the
 * rows it would meet: how many its condition matches, or would change,
 * of how many looked at, and three of them by name. `plan` is the
 * rule's place in `plans`. A rule that cannot be told without running
 * (its own code, a count over other rows, a change as it happens) is
 * said so, with no count.
 */
export async function dryRunRules(ctx: ReviewContext, plans: AssistantPlan[]): Promise<DryRun[]> {
  return inBudget<DryRun>(ctx, async (out) => {
    const read = new Map<string, Promise<SectionRows>>();
    const rowsOf = (at: Section) => {
      if (!read.has(at.mod.id)) read.set(at.mod.id, readSection(ctx, at));
      return read.get(at.mod.id)!;
    };
    for (const [i, plan] of plans.entries()) {
      if (plan.changeType !== "AUTOMATION_ADD" || !plan.automation?.definition) continue;
      const tried = await tryRule(ctx, plans, i, plan, rowsOf);
      if (tried) out.push(tried);
    }
  });
}

async function tryRule(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  i: number,
  plan: AssistantPlan,
  rowsOf: (at: Section) => Promise<SectionRows>
): Promise<DryRun | null> {
  const { name, definition } = plan.automation!;
  const told = (section: string, note: string): DryRun => ({
    plan: i,
    rule: name,
    section,
    matched: null,
    of: null,
    sample: [],
    note,
    everyRow: false,
  });
  const at = sectionFor(ctx, plans, plan.targetModuleId);
  if (!at) return null;
  if ("made" in at) return told(at.made, `${at.made} is new in this design, so it has no rows to try the rule on yet.`);

  const actions = Array.isArray(definition.actions) ? definition.actions : [];
  // ponytail: v1 tries no code; a rule of code could be run on a copy of these rows (lib/code-run) once its count is wanted.
  if (actions.some((a) => a.type === "run_code")) return told(at.name, "A rule of code is tried on its first run.");
  const when = definition.trigger?.when;
  // Every expression it works out: its condition, what it writes, and how it finds the rows it writes to.
  const said = [
    when,
    ...actions.flatMap((a) =>
      a.type === "set_fields"
        ? [...Object.values(a.set ?? {}), "self" in a.target ? null : a.target.match?.to]
        : a.type === "create_record"
          ? Object.values(a.data ?? {})
          : []
    ),
  ].flatMap(nodes);
  if (said.some((n) => "was" in n || n.op === "changed"))
    return told(at.name, "It fires as a row changes, so today's rows cannot say how often.");
  if (said.some((n) => isOperator(n.op) && isServerOnly(n.op)))
    return told(at.name, "It counts other rows as it runs, so it is told on its first run.");

  const got = await rowsOf(at);
  // The rows its condition picks, read as the runtime reads them.
  const hits = when === undefined ? got.rows : got.rows.filter((r) => truthy(evalExpr(when, r)));
  let counted = hits;
  let of = got.rows.length;
  let where = at.name;
  let label = got.label;
  const notes: string[] = [];

  const self = actions.find((a) => a.type === "set_fields" && "self" in a.target);
  const other = actions.find((a) => a.type === "set_fields" && !("self" in a.target));
  if (self?.type === "set_fields") {
    // Only the rows it would really change: a value already there is no change.
    counted = hits.filter((r) =>
      Object.entries(self.set ?? {}).some(([f, e]) => txt(evalExpr(e, r, {}, r)) !== txt(r[f]))
    );
  } else if (other?.type === "set_fields" && !("self" in other.target)) {
    const { module_id, match } = other.target;
    const there = sectionFor(ctx, plans, module_id);
    if (!there) return null;
    if ("made" in there)
      return told(there.made, `${there.made} is new in this design, so it has no rows for the rule to change yet.`);
    const theirs = await rowsOf(there);
    // The rows it writes to are found by plain equal text, as the runtime finds them.
    const keys = new Set(hits.map((r) => txt(evalExpr(match.to, r))).filter(Boolean));
    counted = theirs.rows.filter((t) => keys.has(txt(t[match.field])));
    of = theirs.rows.length;
    where = there.name;
    label = theirs.label;
    notes.push(
      `Found through ${count(hits.length, ctx.locale)} of ${count(got.rows.length, ctx.locale)} ${at.name} rows.`
    );
    if (theirs.total > theirs.rows.length)
      notes.push(`Matched on the newest ${count(of, ctx.locale)} of ${count(theirs.total, ctx.locale)}.`);
  }
  if (where === at.name && got.total > got.rows.length)
    notes.push(`Tried on the newest ${count(of, ctx.locale)} of ${count(got.total, ctx.locale)}.`);
  if (of === 0) notes.push(`${where} has no rows yet.`);
  else if (definition.trigger?.type !== "schedule")
    notes.push("It runs as rows are saved; this is how many match today.");

  return {
    plan: i,
    rule: name,
    section: where,
    matched: counted.length,
    of,
    sample: [...new Set(counted.map(label).filter(Boolean))].slice(0, 3),
    note: notes.join(" ") || null,
    everyRow: counted.length === of && of >= EVERY_ROW_AT,
  };
}
