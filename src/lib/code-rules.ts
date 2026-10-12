// A section's code rules (automation action "run_code") and AI steps
// ("ai_fill", lib/ai-fill.ts), run after the owner's own write.
//
// The database runs a rule's expressions; a rule's own code runs here,
// once the write it follows stands: the row as the owner's screen sees
// it (the store's fields under theirs), the rows of the sections it
// reads, and today, handed to the code in a sealed sandbox
// (lib/code-run.ts). What it hands back is written through the same
// door as the owner's writes (lib/record-write.ts), under their rights,
// and those writes run no code rules of their own: no rule can loop.
//
// And with nobody watching (0134): a rule on a schedule, or on a row the
// store brings in, is queued by the database and run here by the worker
// on the project's ticket (runQueuedJobs), through the same door.
//
// Every run is kept (0206, abo_rule_ran): what it read of each section and
// whether a read was cut short, what it wrote, what was refused and why.
// The Rules dialog, Luke and the owner's own AI read it (lib/rule-runs).
// Before, a run after the owner's write said all this only to the server's
// console, and a rule handed the first 500 of 2,058 rows wrote nothing for
// a day with nobody the wiser (Parent Stock, 11 Oct).
//
// Callers: src/app/api/records/route.ts (after the answer is out),
// src/app/api/code-rules/worker/route.ts (the queue).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALIASES, runCode, runCodeEach, type CodeResult } from "@/lib/code-run";
import { findSection, sectionKey } from "@/lib/section-ref";
import { evalExpr, truthy, withComputed } from "@/lib/expr";
import { writeRecord, type Written } from "@/lib/record-write";
import { STORE_TABLES, isStoreTable, storeSectionColumns, withOwnFields, type StoreTable } from "@/lib/store-read";
import type { AutomationDefinition, SchemaColumn, UiSchema } from "@/lib/types";
import { callModel, fillModel } from "@/lib/ai";
import { fillPrompt, readFill, type FillAsk } from "@/lib/ai-fill";
import { asJob, metered } from "@/lib/usage";

/**
 * Rows of one section a rule is handed: all of them, to this many. Past
 * it the read stops and the run says it was cut short. Big lists fit the
 * machine because only the fields the code names go when all would not
 * (lib/code-run packInputs).
 */
const ROWS_A_SECTION = 50_000;
/** Rows read in one ask: the most the database hands back in one answer. */
const PAGE = 1000;
/** Writes made at once. */
const WRITERS = 8;
/** Queued jobs claimed at a time; batches go on until the worker's time is spent. */
const JOB_BATCH = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Place = { moduleId: string; table: StoreTable | null };
type Rows = Array<{ id: string; data: Record<string, unknown> }>;

/** What a rule reads: each section's rows once, under "#name", and every spelling that means it. */
export type SectionsRead = {
  rows: Record<string, Array<Record<string, unknown>>>;
  places: Record<string, Place>;
  aliases: Record<string, string>;
  /** How many rows of each section it was handed, by the section's name, and whether that was all of them. */
  sizes: Record<string, { rows: number; cut: boolean }>;
};

/**
 * Every row of a section, a page at a time, in the order its list keeps
 * (ties by id, so no page skips or repeats a row): a store list's with the
 * owner's own fields beside each row, or the section's own rows.
 */
async function readAll(
  client: SupabaseClient,
  mod: { id: string; source_table?: unknown },
  storeId: string | null
): Promise<{ rows: Rows; cut: boolean }> {
  const table = isStoreTable(mod.source_table) ? (mod.source_table as StoreTable) : null;
  if (table && !storeId) return { rows: [], cut: false };
  const spec = table ? STORE_TABLES[table] : null;
  const cols = spec
    ? [
        ...new Set([
          ...spec.select
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          ...Object.values(spec.gives ?? {}),
        ]),
      ].join(", ")
    : "id, data";
  const page = async (from: number): Promise<Rows> => {
    if (spec) {
      const { data, error } = await client
        .from(spec.view)
        .select(cols)
        .eq("store_id", storeId!)
        .order(spec.order.field, { ascending: spec.order.ascending })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), data: r }));
    }
    const { data, error } = await client
      .from("records")
      .select(cols)
      .eq("module_id", mod.id)
      .is("store_row_id", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Array<{ id: string; data: Record<string, unknown> | null }>).map((r) => ({
      id: r.id,
      data: r.data ?? {},
    }));
  };
  let rows: Rows = [];
  for (let from = 0; rows.length <= ROWS_A_SECTION; from += PAGE) {
    const got = await page(from);
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  const cut = rows.length > ROWS_A_SECTION;
  if (cut) rows = rows.slice(0, ROWS_A_SECTION);
  if (!spec) return { rows, cut };
  // The owner's own fields on these rows: the section's records read
  // once, a page at a time, never a request for every few rows.
  const own = new Map<string, Record<string, unknown>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("records")
      .select("store_row_id, data")
      .eq("module_id", mod.id)
      .not("store_row_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) own.set(r.store_row_id as string, (r.data ?? {}) as Record<string, unknown>);
    if ((data ?? []).length < PAGE) break;
  }
  return {
    rows: rows.map((r) => {
      const mine = own.get(r.id);
      return mine ? { ...r, data: { ...mine, ...r.data } } : r;
    }),
    cut,
  };
}

/**
 * What a rule's code is handed: a row (with what it was) or a schedule's
 * rows, the sections it reads under every name they go by, and today on
 * the store's clock. One shape for a run and for a try before it is built
 * (lib/dry-run), so the two cannot hand the code different things.
 */
export function codeInput(
  at:
    | { row: Record<string, unknown>; previous: Record<string, unknown> | null }
    | { rows: Array<Record<string, unknown>> },
  given: Pick<SectionsRead, "rows" | "aliases">,
  clock: { today: string; now: string }
) {
  return { ...at, sections: given.rows, [ALIASES]: given.aliases, ...clock };
}

/** Where a write naming `section` lands, however it was spelled; null for one the rule does not read. */
export function placeFor(read: Pick<SectionsRead, "places" | "aliases">, section: string): Place | null {
  return read.places[section] ?? read.places[read.aliases[sectionKey(section)] ?? ""] ?? null;
}

/** The rows of each section a rule reads, once each, and the names they may be asked for by. */
export async function readSections(client: SupabaseClient, projectId: string, refs: string[]): Promise<SectionsRead> {
  const rows: SectionsRead["rows"] = {};
  const places: SectionsRead["places"] = {};
  const aliases: SectionsRead["aliases"] = {};
  const sizes: SectionsRead["sizes"] = {};
  if (!refs.length) return { rows, places, aliases, sizes };
  const { data: mods } = await client
    .from("modules")
    .select("id, name, nav_label, source_table")
    .eq("project_id", projectId);
  const { data: store } = await client
    .from("stores")
    .select("id")
    .eq("project_id", projectId)
    .in("status", ["connected", "uninstalled"])
    .maybeSingle();
  for (const ref of refs) {
    const m = findSection(mods ?? [], ref);
    if (!m) {
      console.error(`[code rule] reads "${ref}", which is no section of project ${projectId}; it is handed no rows.`);
      continue;
    }
    const table = isStoreTable(m.source_table) ? (m.source_table as StoreTable) : null;
    const key = `#${m.name}`;
    if (!(key in rows)) {
      const read = await readAll(client, m as { id: string; source_table: unknown }, (store?.id as string) ?? null);
      rows[key] = read.rows.map((r) => ({ ...r.data, id: r.id }));
      sizes[(m.nav_label as string) || (m.name as string)] = { rows: read.rows.length, cut: read.cut };
    }
    places[key] = { moduleId: m.id as string, table };
    for (const name of [ref, m.name, m.nav_label, m.id]) {
      if (typeof name === "string" && name) aliases[sectionKey(name)] = key;
    }
  }
  return { rows, places, aliases, sizes };
}

/** What a run's writes came to: rows written, writes refused and the first reason, writes past what a run may make. */
type Wrote = { wrote: number; refused: number; why: string | null; dropped: number };

/**
 * What the code handed back, written through the owner's own door, a few
 * at a time. Two writes to one row are one write, the later field winning,
 * as written one after the other they would have been.
 */
async function applyWrites(
  client: SupabaseClient,
  w: Pick<Written, "projectId" | "moduleId">,
  here: Place,
  read: SectionsRead,
  out: CodeResult
): Promise<Wrote> {
  const done: Wrote = { wrote: 0, refused: 0, why: null, dropped: out.dropped ?? 0 };
  const refuse = (why: string) => {
    done.refused += 1;
    done.why ??= why;
  };
  const sets = new Map<string, { where: Place; id: string; fields: Record<string, unknown> }>();
  for (const s of out.set) {
    const where = s.section ? placeFor(read, s.section) : here;
    if (!where) {
      // Said, not skipped: a write that lands nowhere looked exactly like a rule that ran.
      refuse(`a write names section "${s.section}", which the rule does not read`);
      continue;
    }
    const key = `${where.moduleId}:${s.id}`;
    const had = sets.get(key);
    sets.set(key, { where, id: s.id, fields: { ...had?.fields, ...s.fields } });
  }
  const writes: Array<() => Promise<{ status: number; body: Record<string, unknown> }>> = [...sets.values()].map(
    ({ where, id, fields }) =>
      () =>
        writeRecord(client, {
          projectId: w.projectId,
          moduleId: where.moduleId,
          ...(where.table
            ? { action: "update_store_row" as const, storeRowId: id }
            : { action: "update" as const, recordId: id }),
          data: fields,
        })
  );
  // A section over the store takes no rows of the code's: its rows are the store's.
  if (!here.table) {
    for (const a of out.add) {
      writes.push(() =>
        writeRecord(client, { action: "create", projectId: w.projectId, moduleId: w.moduleId, data: a.fields })
      );
    }
  }
  for (let i = 0; i < writes.length; i += WRITERS) {
    for (const res of await Promise.all(writes.slice(i, i + WRITERS).map((go) => go()))) {
      if (res.status === 200) done.wrote += 1;
      else refuse(String(res.body.error ?? res.status));
    }
  }
  return done;
}

/** A run, as it is kept. */
type Kept = {
  ok: boolean;
  trigger: string;
  read: SectionsRead["sizes"];
  error: string | null;
  job?: string;
} & Wrote;

/** One run of a rule, kept where the Rules dialog, Luke and their AI read it (0206). A log that fails never stops a rule. */
async function keepRun(client: SupabaseClient, ruleId: string, recordId: string | null, run: Kept): Promise<void> {
  const { error } = await client.rpc("abo_rule_ran", {
    p_rule: ruleId,
    p_record: recordId && UUID.test(recordId) ? recordId : null,
    p_ok: run.ok,
    p_detail: { kind: "code", ...run, error: run.error?.slice(0, 300) ?? null },
  });
  if (error) console.error(`[code rule] a run of ${ruleId} was not kept: ${error.message}`);
}

/** Why a run did not do all it meant to, or null: its code's error, else the writes refused. */
function whyNot(codeError: string | null, wrote: Wrote): string | null {
  if (codeError) return codeError;
  if (wrote.refused) {
    const of = wrote.wrote + wrote.refused;
    return `${wrote.refused} of ${of} ${of === 1 ? "write was" : "writes were"} refused: ${wrote.why}`;
  }
  return null;
}

export async function runCodeRules(client: SupabaseClient, w: Written): Promise<void> {
  try {
    const { data: rules } = await client
      .from("automations")
      .select("id, name, definition")
      .eq("module_id", w.moduleId)
      .eq("enabled", true);
    const coded = (rules ?? []).filter((r) =>
      (r.definition as AutomationDefinition | null)?.actions?.some((a) => a.type === "run_code" || a.type === "ai_fill")
    );
    if (!coded.length) return;

    // The row as the owner's screen sees it: on a section over the store,
    // the store's fields under theirs, and the store row's own id.
    const own = (w.record.data ?? {}) as Record<string, unknown>;
    let theirs: Record<string, unknown> = {};
    if (w.table && w.storeRowId) {
      const spec = STORE_TABLES[w.table];
      const { data } = await client.from(spec.view).select(spec.select).eq("id", w.storeRowId).maybeSingle();
      theirs = (data ?? {}) as Record<string, unknown>;
    }
    const row = withComputed(w.columns, { ...own, ...theirs });
    const previous = w.previous ? withComputed(w.columns, { ...w.previous, ...theirs }) : null;
    const id = w.table && w.storeRowId ? w.storeRowId : String(w.record.id);
    const here: Place = { moduleId: w.moduleId, table: w.table };

    for (const r of coded) {
      const def = r.definition as AutomationDefinition;
      const on = def.trigger?.type;
      if (!((on === "record_created" && w.event === "created") || (on === "record_updated" && w.event === "updated"))) {
        continue;
      }
      if (def.trigger.when !== undefined && !truthy(evalExpr(def.trigger.when, row, previous ?? {}))) continue;
      for (const a of def.actions) {
        if (a.type === "ai_fill") {
          await runFill(client, w, r, a, row);
          continue;
        }
        if (a.type !== "run_code") continue;
        // Each rule's run is its own: one that breaks is kept as broken, and the next still runs.
        let sizes: SectionsRead["sizes"] = {};
        try {
          const t0 = Date.now();
          const given = await readSections(client, w.projectId, a.reads ?? []);
          sizes = given.sizes;
          const read = Date.now() - t0;
          const out = await runCode(
            a.code,
            codeInput({ row: { id, ...row }, previous }, given, storeClock(await storeZone(client, w.projectId)))
          );
          const wrote = out.ok
            ? await applyWrites(client, w, here, given, out.result)
            : { wrote: 0, refused: 0, why: null, dropped: 0 };
          const error = whyNot(out.ok ? null : out.error, wrote);
          await keepRun(client, r.id as string, id, { ok: !error, trigger: on, read: sizes, error, ...wrote });
          console.log(
            `[code rule] "${r.name}": read ${read}ms, ran and wrote ${Date.now() - t0 - read}ms, ${wrote.wrote} written${error ? `; ${error}` : ""}`
          );
        } catch (e) {
          const error = e instanceof Error ? e.message : "The rule stopped.";
          console.error(`[code rule] "${r.name}": ${error}`);
          await keepRun(client, r.id as string, id, {
            ok: false,
            trigger: on,
            read: sizes,
            error,
            wrote: 0,
            refused: 0,
            why: null,
            dropped: 0,
          });
        }
      }
    }
  } catch (e) {
    console.error(`[code rule] ${e instanceof Error ? e.message : "failed"}`);
  }
}

/**
 * A rule's AI step on the row just written (lib/ai-fill.ts, 0182): the
 * row's words read on the fill model, and only what is still empty filled,
 * each value held to what its field may hold, through the same door as
 * the owner's writes. Nothing to read or nothing left to fill is no run
 * and no cost; past the project's day it is not run, and the rule says so.
 */
async function runFill(
  client: SupabaseClient,
  w: Written,
  rule: { id: string; name: string },
  a: FillAsk,
  row: Record<string, unknown>
): Promise<void> {
  const model = fillModel();
  if (!model) {
    console.log(`[ai step] "${rule.name}": ANTHROPIC_FILL_MODEL is not set; nothing filled`);
    return;
  }
  const { data: ui } = await client
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", w.moduleId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const schema = { ...(ui?.schema_json as UiSchema | null), columns: w.columns } as UiSchema;
  const prompt = fillPrompt(schema, a, row, storeClock(await storeZone(client, w.projectId)).today);
  if (!prompt) return;
  const recordId = String(w.record.id);
  const { data: run } = await client.rpc("abo_ai_fill_claim", { p_automation: rule.id, p_record: recordId });
  if (!run) {
    console.log(`[ai step] "${rule.name}": not run (the project's day is used, or the rule is not this caller's)`);
    return;
  }
  try {
    const [raw, usage] = await metered(() =>
      asJob("fill", () => callModel({ system: prompt.system, turns: [{ role: "user", content: prompt.user }], model }))
    );
    const { data: mod } = await client.from("modules").select("nav_label").eq("id", w.moduleId).maybeSingle();
    const { set, left } = readFill(raw, schema, (mod?.nav_label as string | undefined) ?? "this section", a, row);
    if (Object.keys(set).length) {
      const res = await writeRecord(client, {
        projectId: w.projectId,
        moduleId: w.moduleId,
        ...(w.table && w.storeRowId
          ? { action: "update_store_row" as const, storeRowId: w.storeRowId }
          : { action: "update" as const, recordId }),
        data: set,
      });
      if (res.status !== 200) left.push(`the row would not take it: ${String(res.body.error ?? res.status)}`);
    }
    // Its own meter, as the console's Agents screen reads it (0185): no turn holds it.
    const u = usage();
    await client.rpc("abo_ai_fill_done", {
      p_run: run,
      p_ok: true,
      p_detail: {
        filled: Object.keys(set),
        left: left.slice(0, 5),
        usd: u?.usd ?? null,
        input: u?.uses.reduce((s, x) => s + x.input, 0) ?? null,
        output: u?.uses.reduce((s, x) => s + x.output, 0) ?? null,
        model,
      },
    });
  } catch (e) {
    await client.rpc("abo_ai_fill_done", {
      p_run: run,
      p_ok: false,
      p_detail: { error: (e instanceof Error ? e.message : "failed").slice(0, 200), model },
    });
  }
}

/** A job as the queue keeps it (0134). */
/**
 * The store's own clock: today and now as they read there, "YYYY-MM-DD"
 * and "YYYY-MM-DDTHH:MM". A rule's code works in these and answers in
 * them ("next"), so it never does timezone arithmetic; UTC without a
 * store or with a zone this runtime does not know.
 */
export function storeClock(zone: string, at = new Date()): { today: string; now: string } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value])
    );
  } catch {
    return storeClock("UTC", at);
  }
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return { today, now: `${today}T${parts.hour}:${parts.minute}` };
}

/** The timezone a project's store keeps, the clock its rules run on. */
export async function storeZone(client: SupabaseClient, projectId: string): Promise<string> {
  const { data } = await client
    .from("stores")
    .select("timezone")
    .eq("project_id", projectId)
    .in("status", ["connected", "uninstalled"])
    .maybeSingle();
  return (data?.timezone as string | undefined) || "UTC";
}

type Job = { id: string; automation_id: string; kind: "schedule" | "added"; row_ids: string[]; attempts: number };

/** The project's store, when it has one it may read. */
async function storeOf(client: SupabaseClient, projectId: string): Promise<string | null> {
  const { data } = await client
    .from("stores")
    .select("id")
    .eq("project_id", projectId)
    .in("status", ["connected", "uninstalled"])
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** One queued job, run: why it did not, or null. */
async function runJob(client: SupabaseClient, projectId: string, job: Job): Promise<string | null> {
  const { data: rule } = await client
    .from("automations")
    .select("id, name, module_id, enabled, definition")
    .eq("id", job.automation_id)
    .maybeSingle();
  if (!rule?.enabled) return "The rule is off, or gone.";
  const def = rule.definition as AutomationDefinition;
  const moduleId = rule.module_id as string;
  const { data: mod } = await client.from("modules").select("source_table, nav_label").eq("id", moduleId).maybeSingle();
  const table = isStoreTable(mod?.source_table) ? (mod!.source_table as StoreTable) : null;
  const { data: schemaRow } = await client
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", moduleId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const saved = (schemaRow?.schema_json as UiSchema | undefined)?.columns ?? [];
  const columns: SchemaColumn[] = table ? storeSectionColumns(table, saved) : saved;
  const storeId = table ? await storeOf(client, projectId) : null;
  if (table && !storeId) return "The project has no store to read.";

  // The rows it is for: the ones the store brought in, or every row of the section.
  let rows: Rows;
  let own: { rows: number; cut: boolean } | null = null;
  if (job.kind === "added") {
    const spec = STORE_TABLES[table!];
    const { data } = await client.from(spec.view).select(spec.select).eq("store_id", storeId!).in("id", job.row_ids);
    rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), data: r }));
    rows = await withOwnFields(client, moduleId, rows);
  } else {
    const read = await readAll(client, { id: moduleId, source_table: mod?.source_table }, storeId);
    rows = read.rows;
    own = { rows: read.rows.length, cut: read.cut };
  }
  const seen = rows
    .map((r) => ({ id: r.id, ...withComputed(columns, r.data) }))
    .filter((r) => def.trigger.when === undefined || truthy(evalExpr(def.trigger.when, r, {})));

  const clock = storeClock(await storeZone(client, projectId));
  const here: Place = { moduleId, table };
  const errors: string[] = [];
  const total: Wrote = { wrote: 0, refused: 0, why: null, dropped: 0 };
  let sizes: SectionsRead["sizes"] = own ? { [(mod?.nav_label as string) || "its own section"]: own } : {};
  for (const a of def.actions) {
    if (a.type !== "run_code") continue;
    const given = await readSections(client, projectId, a.reads ?? []);
    sizes = { ...sizes, ...given.sizes };
    // A row the store brought in is handed as a row, as an added one is;
    // a schedule hands the section's rows, and no row.
    const inputs =
      job.kind === "added"
        ? seen.map((row) => codeInput({ row, previous: null }, given, clock))
        : [codeInput({ rows: seen }, given, clock)];
    const outs = await runCodeEach(a.code, inputs);
    for (const out of outs) {
      if (!out.ok) {
        errors.push(out.error);
        continue;
      }
      const wrote = await applyWrites(client, { projectId, moduleId }, here, given, out.result);
      total.wrote += wrote.wrote;
      total.refused += wrote.refused;
      total.why ??= wrote.why;
      total.dropped += wrote.dropped;
      // A schedule's own code may say when it runs next; the database keeps it on the rule.
      if (job.kind === "schedule" && out.result.next) {
        await client.rpc("abo_code_next", { p_rule: rule.id, p_at: out.result.next });
      }
    }
    console.log(
      `[code rule] "${rule.name}" (${job.kind}): ${inputs.length} run${inputs.length === 1 ? "" : "s"}, ${errors.length} failed, ${total.wrote} written`
    );
  }
  const why = whyNot(errors[0] ?? null, total);
  await keepRun(client, rule.id as string, job.row_ids.length === 1 ? job.row_ids[0] : null, {
    ok: !why,
    trigger: def.trigger.type,
    read: sizes,
    error: why,
    job: job.id,
    ...total,
  });
  return why;
}

/**
 * The project's queued code, run until `until` (epoch ms): each job
 * claimed, run, and marked done or failed with why. The client carries
 * the project's ticket; everything it reads and writes is that project's.
 */
export async function runQueuedJobs(client: SupabaseClient, projectId: string, until: number): Promise<number> {
  let ran = 0;
  // A batch at a time until the time is spent: twenty and stop left an
  // order burst's three hundred jobs a quarter of an hour behind.
  for (;;) {
    if (Date.now() > until) return ran;
    const { data: jobs } = await client
      .from("code_jobs")
      .select("id, automation_id, kind, row_ids, attempts")
      .eq("project_id", projectId)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(JOB_BATCH);
    if (!jobs?.length) return ran;
    const before = ran;
    for (const job of jobs as Job[]) {
      if (Date.now() > until) break;
      const { data: claimed } = await client
        .from("code_jobs")
        .update({ status: "running", attempts: job.attempts + 1, started_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("status", "queued")
        .select("id");
      if (!claimed?.length) continue;
      let why: string | null;
      try {
        why = await runJob(client, projectId, job);
      } catch (e) {
        why = e instanceof Error ? e.message : "The job failed.";
        await keepRun(client, job.automation_id, null, {
          ok: false,
          trigger: job.kind === "added" ? "store_row_added" : "schedule",
          read: {},
          error: why,
          job: job.id,
          wrote: 0,
          refused: 0,
          why: null,
          dropped: 0,
        });
      }
      await client
        .from("code_jobs")
        .update({ status: why ? "failed" : "done", error: why, finished_at: new Date().toISOString() })
        .eq("id", job.id);
      ran += 1;
    }
    // Every one claimed by another worker: theirs to finish, not a reason to spin.
    if (ran === before) return ran;
  }
}
