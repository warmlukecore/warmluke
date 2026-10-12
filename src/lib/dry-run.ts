// A rule of a design, run in the head before it is built: its condition
// over the rows it would meet, so the owner reads "would change 2,353 of
// 2,353 shipments" or "23 of 412 orders match" on the design's card
// before the rule has written anything. A rule that writes "No" into
// every row every hour looks like any other rule on paper; counted, it
// does not.
//
// A rule of code is run for real, as its runs will run it (12 Oct): the
// runtime's own reader of the sections it reads, the same input and the
// same sandbox (lib/code-rules, lib/code-run), on rows of its section as if
// each had just been added or changed, and what it hands back is read,
// never written. A rule that throws, writes a field that is not there or a
// section it does not read, or reads a list only in part, is a problem
// found before the owner sees it; one that changes nothing is said so. A
// rule set off by a change is tried as if each row had just changed. Before,
// both were "tried on their first run", and a rule handed 500 of 2,058 rows
// wrote nothing for a day (Parent Stock, 11 Oct).
//
// No model and no write. The rows are read on the caller's own client,
// so RLS decides what may be counted, and the expressions are worked out
// by lib/expr, the runtime's own twin of the database's evaluator: a
// blank reads as the runtime reads it, never as this file guesses.
//
// The section reader here is the data check's too (lib/data-check.ts).
//
// Callers: src/lib/review-gate.ts, src/lib/data-check.ts, src/lib/verify.ts.

import { isOperator, isServerOnly } from "@/lib/capabilities";
import { codeInput, placeFor, readSections, storeClock, storeZone } from "@/lib/code-rules";
import { ADDS_MAX, SETS_MAX, canRunCode, runCodeEach } from "@/lib/code-run";
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
/** Trying a design's rules of code: a sandbox to start, and the sections they read, whole. */
export const CODE_BUDGET_MS = 20_000;
/** Rows of a rule's own section it is tried on, as if each had just been added or changed. */
const TRY_ROWS = 3;

/** What trying a rule of code reaches: the runtime's reader, sandbox and clock; a check stands in for them. */
export type CodeTry = {
  can: () => boolean;
  read: typeof readSections;
  run: typeof runCodeEach;
  zone: typeof storeZone;
};
const RUNTIME: CodeTry = { can: canRunCode, read: readSections, run: runCodeEach, zone: storeZone };

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
    type Page = { rows?: Array<{ id?: string; data?: Row }>; total?: number; facets?: Record<string, string[]> };
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
    raw = pages.flatMap((p) => (p.rows ?? []).map((r) => ({ ...r.data, id: r.id ?? r.data?.id })));
  } else {
    for (let from = 0; from < ROWS_READ; from += OWN_PAGE) {
      const {
        data,
        count: n,
        error,
      } = await ctx.db
        .from("records")
        .select("id, data", from === 0 ? { count: "exact" } : undefined)
        .eq("module_id", at.mod.id)
        .is("store_row_id", null)
        .order("created_at", { ascending: false })
        .range(from, Math.min(from + OWN_PAGE, ROWS_READ) - 1);
      if (error) throw new Error(error.message);
      if (from === 0) total = n ?? (data ?? []).length;
      raw.push(...(data ?? []).map((r) => ({ ...(r as { data?: Row }).data, id: (r as { id?: string }).id })));
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
export async function inBudget<T>(ctx: ReviewContext, work: (out: T[]) => Promise<void>, ms = BUDGET_MS): Promise<T[]> {
  if (ctx.signal?.aborted) return [];
  const out: T[] = [];
  let quit!: () => void;
  const stop = new Promise<void>((resolve) => (quit = resolve));
  const timer = setTimeout(quit, ms);
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
 * rule's place in `plans`. A rule of code is run as its runs will run it
 * (tryCode), after the rest, its place held by "not tried in time" until
 * it is; a rule that counts other rows as it runs is said so, with no count.
 */
export async function dryRunRules(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  use: CodeTry = RUNTIME
): Promise<DryRun[]> {
  const rules = [...plans.entries()].filter(([, p]) => p.changeType === "AUTOMATION_ADD" && !!p.automation?.definition);
  return inBudget<DryRun>(
    ctx,
    async (out) => {
      const read = new Map<string, Promise<SectionRows>>();
      const rowsOf = (at: Section) => {
        if (!read.has(at.mod.id)) read.set(at.mod.id, readSection(ctx, at));
        return read.get(at.mod.id)!;
      };
      for (const [i, plan] of rules.filter(([, p]) => !coded(p))) {
        const tried = await tryRule(ctx, plans, i, plan, rowsOf);
        if (tried) out.push(tried);
      }
      for (const [i, plan] of rules.filter(([, p]) => coded(p))) {
        const at = sectionFor(ctx, plans, plan.targetModuleId);
        if (!at) continue;
        const name = plan.automation!.name;
        if ("made" in at) {
          out.push(
            blank(i, name, at.made, `${at.made} is new in this design, so it has no rows to try the rule on yet.`)
          );
          continue;
        }
        const place = out.push(blank(i, name, at.name, "Not tried in time.")) - 1;
        out[place] = await tryCode(ctx, plans, i, plan, at, rowsOf, use);
      }
    },
    rules.some(([, p]) => coded(p)) ? CODE_BUDGET_MS : BUDGET_MS
  );
}

/** Whether a plan's rule has code of its own to run. */
const coded = (p: AssistantPlan) => (p.automation?.definition?.actions ?? []).some((a) => a.type === "run_code");

/** A field as a column calls it. */
const label = (f: string, cols: SchemaColumn[]) => cols.find((c) => c.field === f)?.label ?? f;

/** A rule's line with no count: what can be said of it instead. */
const blank = (plan: number, rule: string, section: string, note: string): DryRun => ({
  plan,
  rule,
  section,
  matched: null,
  of: null,
  sample: [],
  note,
  everyRow: false,
});

/** The fields a rule watches change: what its `changed` and `was` read. */
function watchedBy(said: Row[]): string[] {
  const read = said.flatMap((n) =>
    "was" in n ? [txt(n.was)] : n.op === "changed" ? [txt((n.args as Row[] | undefined)?.[0]?.field)] : []
  );
  return [...new Set(read.filter(Boolean))];
}

/** A row as it was just before those fields changed: blank where they hold something now, something where they are blank. */
const before = (r: Row, fields: string[]): Row => ({
  ...r,
  ...Object.fromEntries(fields.map((f) => [f, txt(r[f]) === "" ? "‹before›" : null])),
});

async function tryRule(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  i: number,
  plan: AssistantPlan,
  rowsOf: (at: Section) => Promise<SectionRows>
): Promise<DryRun | null> {
  const { name, definition } = plan.automation!;
  const told = (section: string, note: string): DryRun => blank(i, name, section, note);
  const at = sectionFor(ctx, plans, plan.targetModuleId);
  if (!at) return null;
  if ("made" in at) return told(at.made, `${at.made} is new in this design, so it has no rows to try the rule on yet.`);

  const actions = Array.isArray(definition.actions) ? definition.actions : [];
  if (actions.some((a) => a.type === "ai_fill"))
    return told(
      at.name,
      "An AI step reads each row's own words when it is added or changed; it is tried on its first."
    );
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
  // Set off by a change: tried as if each row's watched fields had just changed.
  const watched = watchedBy(said);
  const prevOf = (r: Row): Row => (watched.length ? before(r, watched) : {});
  if (said.some((n) => isOperator(n.op) && isServerOnly(n.op)))
    return told(at.name, "It counts other rows as it runs, so it is told on its first run.");

  const got = await rowsOf(at);
  // The rows its condition picks, read as the runtime reads them.
  const hits = when === undefined ? got.rows : got.rows.filter((r) => truthy(evalExpr(when, r, prevOf(r))));
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
      Object.entries(self.set ?? {}).some(([f, e]) => txt(evalExpr(e, r, prevOf(r), r)) !== txt(r[f]))
    );
  } else if (other?.type === "set_fields" && !("self" in other.target)) {
    const { module_id, match } = other.target;
    const there = sectionFor(ctx, plans, module_id);
    if (!there) return null;
    if ("made" in there)
      return told(there.made, `${there.made} is new in this design, so it has no rows for the rule to change yet.`);
    const theirs = await rowsOf(there);
    // The rows it writes to are found by plain equal text, as the runtime finds them.
    const keys = new Set(hits.map((r) => txt(evalExpr(match.to, r, prevOf(r)))).filter(Boolean));
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
  if (watched.length)
    notes.unshift(
      `As if each row's ${watched.map((f) => at.columns.find((c) => c.field === f)?.label ?? f).join(" and ")} had just changed.`
    );
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
    everyRow: counted.length === of && of >= EVERY_ROW_AT && !watched.length,
  };
}

/**
 * A rule of code, run as its runs will run it, nothing written: on a
 * schedule once with its section's rows; set off by a row, on up to
 * TRY_ROWS of its section's newest rows that would set it off (as if each
 * had just been added, or its watched fields had just changed), or, when
 * none would, on the newest as if they did. The sections it reads come
 * through the runtime's own reader, whole, so a reader that falls short
 * falls short here too. What it hands back is read for what would stop it
 * working, and counted.
 */
async function tryCode(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  i: number,
  plan: AssistantPlan,
  at: Section,
  rowsOf: (at: Section) => Promise<SectionRows>,
  use: CodeTry
): Promise<DryRun> {
  const { name, definition } = plan.automation!;
  const told = (note: string): DryRun => blank(i, name, at.name, note);
  if (!use.can()) return told("Not tried here: there is no sandbox to run code in.");
  const on = definition.trigger?.type;
  const when = definition.trigger?.when;
  const clock = storeClock(await use.zone(ctx.db, ctx.projectId));

  // What sets it off, as the runtime hands it over.
  let given: Array<{ row: Row; previous: Row | null } | { rows: Row[] }>;
  let tried: Row[] = [];
  let lead: string;
  const got = await rowsOf(at);
  if (on === "schedule") {
    const own = await use.read(ctx.db, ctx.projectId, [at.mod.id]);
    const rows = (Object.values(own.rows)[0] ?? [])
      .map((r) => ({ ...withComputed(at.columns, r), id: r.id }))
      .filter((r) => when === undefined || truthy(evalExpr(when, r, {})));
    given = [{ rows }];
    tried = rows;
    lead = `Run once now, on the ${count(rows.length, ctx.locale)} ${at.name} rows it would be handed`;
  } else {
    const watched = watchedBy(nodes(when));
    const changed = on === "record_updated";
    const prevOf = (r: Row): Row | null => (changed ? (watched.length ? before(r, watched) : { ...r }) : null);
    const fires = got.rows
      .filter((r) => when === undefined || truthy(evalExpr(when, r, prevOf(r) ?? {})))
      .slice(0, TRY_ROWS);
    tried = fires.length ? fires : got.rows.slice(0, TRY_ROWS);
    if (!tried.length) return told(`${at.name} has no rows yet: it is tried when its first comes in.`);
    given = tried.map((r) => ({ row: r, previous: prevOf(r) }));
    const names = tried.map(got.label).filter(Boolean);
    const which = names.length ? names.map((n) => `'${n}'`).join(", ") : `${tried.length} of its rows`;
    const what = changed
      ? watched.length
        ? `${watched.map((f) => label(f, at.columns)).join(" and ")} on ${which} had just changed`
        : `${which} had just been changed`
      : `${which} had just been added`;
    lead = fires.length
      ? `Tried as if ${what}`
      : `None of the newest ${at.name} rows would set it off; tried as if ${what}`;
  }

  // Run, and read what it hands back.
  const problems = new Set<string>();
  const wrote = new Map<string, { section: string; of: number | null; rows: Set<string>; fields: Set<string> }>();
  let added = 0;
  for (const a of definition.actions ?? []) {
    if (a.type !== "run_code") continue;
    const read = await use.read(ctx.db, ctx.projectId, a.reads ?? []);
    for (const [section, size] of Object.entries(read.sizes))
      if (size.cut)
        problems.add(
          `It reads only the first ${count(size.rows, ctx.locale)} rows of ${section}; the rest are never seen.`
        );
    const outs = await use.run(
      a.code,
      given.map((g) => codeInput(g, read, clock))
    );
    for (const out of outs) {
      if (!out.ok) {
        problems.add(`It stops with: ${out.error}`);
        continue;
      }
      const { set, add } = out.result;
      if (set.length > SETS_MAX)
        problems.add(`It would set ${count(set.length, ctx.locale)} rows in one run; a run sets at most ${SETS_MAX}.`);
      if (add.length > ADDS_MAX)
        problems.add(`It would add ${count(add.length, ctx.locale)} rows in one run; a run adds at most ${ADDS_MAX}.`);
      if (add.length && at.table)
        problems.add(`It adds rows to ${at.name}, a list over the store, which takes no new rows.`);
      else added += add.length;
      for (const s of set) {
        const place = s.section ? placeFor(read, s.section) : { moduleId: at.mod.id, table: at.table };
        if (!place) {
          problems.add(`It writes to "${s.section}", which it does not read: that write lands nowhere.`);
          continue;
        }
        const there = place.moduleId === at.mod.id ? at : sectionFor(ctx, plans, place.moduleId);
        if (!there || "made" in there) continue;
        const theirs = new Set(there.table ? STORE_TABLES[there.table].columns.map((c) => c.field) : []);
        for (const f of Object.keys(s.fields ?? {})) {
          const col = there.columns.find((c) => c.field === f);
          if (!col) problems.add(`It writes "${f}" on ${there.name}, which has no such field.`);
          else if (col.compute)
            problems.add(`It writes ${col.label} on ${there.name}, which is worked out and cannot be written.`);
          else if (theirs.has(f))
            problems.add(
              `It writes ${col.label} on ${there.name}, which is the store's own and changes only in Shopify.`
            );
        }
        // The row it names must be one it was handed: any other write is refused.
        const key = Object.entries(read.places).find(([, p]) => p.moduleId === place.moduleId)?.[0];
        const pool = key ? (read.rows[key] ?? []) : tried;
        if (!pool.some((r) => String(r.id) === String(s.id)))
          problems.add(`It writes to a row of ${there.name} it was not handed, so that write would be refused.`);
        const size = key ? (read.sizes[there.name]?.rows ?? pool.length) : null;
        const w = wrote.get(there.mod.id) ?? { section: there.name, of: size, rows: new Set(), fields: new Set() };
        w.rows.add(String(s.id));
        for (const f of Object.keys(s.fields ?? {})) w.fields.add(label(f, there.columns));
        wrote.set(there.mod.id, w);
      }
    }
  }

  const each = [...wrote.values()];
  const changes = [
    ...each.map(
      (w) =>
        `would set ${[...w.fields].join(", ")} on ${count(w.rows.size, ctx.locale)} ${w.section} ${w.rows.size === 1 ? "row" : "rows"}`
    ),
    ...(added ? [`would add ${count(added, ctx.locale)} ${added === 1 ? "row" : "rows"}`] : []),
  ];
  const first = each[0];
  return {
    plan: i,
    rule: name,
    section: first?.section ?? at.name,
    matched: each.reduce((n, w) => n + w.rows.size, 0) + added,
    of: first?.of ?? null,
    sample: [],
    note: `${lead}: ${changes.length ? changes.join("; ") : "it changed nothing"}.`,
    everyRow: false,
    problem: problems.size ? [...problems].slice(0, 3).join(" ") : null,
  };
}
