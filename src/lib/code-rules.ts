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
// Callers: src/app/api/records/route.ts (after the answer is out),
// src/app/api/code-rules/worker/route.ts (the queue).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALIASES, runCode, runCodeEach, type CodeResult } from "@/lib/code-run";
import { findSection, sectionKey } from "@/lib/section-ref";
import { evalExpr, truthy, withComputed } from "@/lib/expr";
import { writeRecord, type Written } from "@/lib/record-write";
import {
  STORE_TABLES,
  isStoreTable,
  readStoreRows,
  storeSectionColumns,
  withOwnFields,
  type StoreTable,
} from "@/lib/store-read";
import type { AutomationDefinition, SchemaColumn, UiSchema } from "@/lib/types";
import { callModel, fillModel } from "@/lib/ai";
import { fillPrompt, readFill, type FillAsk } from "@/lib/ai-fill";
import { asJob, metered } from "@/lib/usage";

/** Rows of a read section handed to the code. ponytail: the newest 500; a rule over a bigger list is asked to read less. */
const ROWS_A_SECTION = 500;

type Place = { moduleId: string; table: StoreTable | null };

/** What a rule reads: each section's rows once, under "#name", and every spelling that means it. */
export type SectionsRead = {
  rows: Record<string, Array<Record<string, unknown>>>;
  places: Record<string, Place>;
  aliases: Record<string, string>;
};

/** Where a write naming `section` lands, however it was spelled; null for one the rule does not read. */
export function placeFor(read: Pick<SectionsRead, "places" | "aliases">, section: string): Place | null {
  return read.places[section] ?? read.places[read.aliases[sectionKey(section)] ?? ""] ?? null;
}

/** The rows of each section a rule reads, once each, and the names they may be asked for by. */
async function readSections(client: SupabaseClient, projectId: string, refs: string[]): Promise<SectionsRead> {
  const rows: SectionsRead["rows"] = {};
  const places: SectionsRead["places"] = {};
  const aliases: SectionsRead["aliases"] = {};
  if (!refs.length) return { rows, places, aliases };
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
    let got: Array<Record<string, unknown>> = [];
    if (table && store) {
      const { rows: theirs } = await readStoreRows(client, store.id as string, table, ROWS_A_SECTION);
      got = (await withOwnFields(client, m.id as string, theirs)).map((r) => ({ id: r.id, ...r.data }));
    } else if (!table) {
      const { data } = await client
        .from("records")
        .select("id, data")
        .eq("module_id", m.id)
        .is("store_row_id", null)
        .order("created_at", { ascending: false })
        .limit(ROWS_A_SECTION);
      got = (data ?? []).map((r) => ({ id: r.id, ...((r.data ?? {}) as Record<string, unknown>) }));
    }
    const key = `#${m.name}`;
    rows[key] = got;
    places[key] = { moduleId: m.id as string, table };
    for (const name of [ref, m.name, m.nav_label, m.id]) {
      if (typeof name === "string" && name) aliases[sectionKey(name)] = key;
    }
  }
  return { rows, places, aliases };
}

/** What the code handed back, written through the owner's own door. */
async function applyWrites(
  client: SupabaseClient,
  w: Pick<Written, "projectId" | "moduleId">,
  here: Place,
  read: SectionsRead,
  out: CodeResult
) {
  for (const s of out.set) {
    const where = s.section ? placeFor(read, s.section) : here;
    if (!where) {
      // Said, not skipped: a write that lands nowhere looked exactly like a rule that ran.
      console.error(
        `[code rule] a write names section "${s.section}", which the rule does not read (project ${w.projectId}); nothing was written there.`
      );
      continue;
    }
    const res = await writeRecord(client, {
      projectId: w.projectId,
      moduleId: where.moduleId,
      ...(where.table
        ? { action: "update_store_row" as const, storeRowId: s.id }
        : { action: "update" as const, recordId: s.id }),
      data: s.fields,
    });
    if (res.status !== 200)
      console.error(
        `[code rule] a write to ${where.moduleId} (project ${w.projectId}) was refused: ${String(res.body.error ?? res.status)}`
      );
  }
  if (here.table) return;
  for (const a of out.add) {
    const res = await writeRecord(client, {
      action: "create",
      projectId: w.projectId,
      moduleId: w.moduleId,
      data: a.fields,
    });
    if (res.status !== 200) console.error(`[code rule] a row was refused: ${String(res.body.error ?? res.status)}`);
  }
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
        const t0 = Date.now();
        const given = await readSections(client, w.projectId, a.reads ?? []);
        const read = Date.now() - t0;
        const out = await runCode(a.code, {
          row: { id, ...row },
          previous,
          sections: given.rows,
          [ALIASES]: given.aliases,
          ...storeClock(await storeZone(client, w.projectId)),
        });
        if (!out.ok) {
          console.error(`[code rule] "${r.name}": ${out.error}`);
          continue;
        }
        const ran = Date.now() - t0 - read;
        await applyWrites(client, w, here, given, out.result);
        console.log(`[code rule] "${r.name}": read ${read}ms, ran ${ran}ms, wrote ${Date.now() - t0 - read - ran}ms`);
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
    await client.rpc("abo_ai_fill_done", {
      p_run: run,
      p_ok: true,
      p_detail: { filled: Object.keys(set), left: left.slice(0, 5), usd: usage()?.usd ?? null, model },
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
async function storeZone(client: SupabaseClient, projectId: string): Promise<string> {
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
  const { data: mod } = await client.from("modules").select("source_table").eq("id", moduleId).maybeSingle();
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
  let rows: Array<{ id: string; data: Record<string, unknown> }>;
  if (job.kind === "added") {
    const spec = STORE_TABLES[table!];
    const { data } = await client.from(spec.view).select(spec.select).eq("store_id", storeId!).in("id", job.row_ids);
    rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), data: r }));
    rows = await withOwnFields(client, moduleId, rows);
  } else if (table) {
    rows = await withOwnFields(client, moduleId, (await readStoreRows(client, storeId!, table, ROWS_A_SECTION)).rows);
  } else {
    const { data } = await client
      .from("records")
      .select("id, data")
      .eq("module_id", moduleId)
      .is("store_row_id", null)
      .order("created_at", { ascending: false })
      .limit(ROWS_A_SECTION);
    rows = (data ?? []).map((r) => ({ id: r.id as string, data: (r.data ?? {}) as Record<string, unknown> }));
  }
  const seen = rows
    .map((r) => ({ id: r.id, ...withComputed(columns, r.data) }))
    .filter((r) => def.trigger.when === undefined || truthy(evalExpr(def.trigger.when, r, {})));

  const clock = storeClock(await storeZone(client, projectId));
  const here: Place = { moduleId, table };
  const errors: string[] = [];
  for (const a of def.actions) {
    if (a.type !== "run_code") continue;
    const given = await readSections(client, projectId, a.reads ?? []);
    const sections = given.rows;
    const named = { [ALIASES]: given.aliases };
    // A row the store brought in is handed as a row, as an added one is;
    // a schedule hands the section's rows, and no row.
    const inputs =
      job.kind === "added"
        ? seen.map((row) => ({ row, previous: null, sections, ...named, ...clock }))
        : [{ rows: seen, sections, ...named, ...clock }];
    const outs = await runCodeEach(a.code, inputs);
    for (const out of outs) {
      if (!out.ok) {
        errors.push(out.error);
        continue;
      }
      await applyWrites(client, { projectId, moduleId }, here, given, out.result);
      // A schedule's own code may say when it runs next; the database keeps it on the rule.
      if (job.kind === "schedule" && out.result.next) {
        await client.rpc("abo_code_next", { p_rule: rule.id, p_at: out.result.next });
      }
    }
    console.log(
      `[code rule] "${rule.name}" (${job.kind}): ${inputs.length} run${inputs.length === 1 ? "" : "s"}, ${errors.length} failed`
    );
  }
  return errors.length ? errors[0] : null;
}

/**
 * The project's queued code, run until `until` (epoch ms): each job
 * claimed, run, and marked done or failed with why. The client carries
 * the project's ticket; everything it reads and writes is that project's.
 */
export async function runQueuedJobs(client: SupabaseClient, projectId: string, until: number): Promise<number> {
  const { data: jobs } = await client
    .from("code_jobs")
    .select("id, automation_id, kind, row_ids, attempts")
    .eq("project_id", projectId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(20);
  let ran = 0;
  for (const job of (jobs ?? []) as Job[]) {
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
    }
    await client
      .from("code_jobs")
      .update({ status: why ? "failed" : "done", error: why, finished_at: new Date().toISOString() })
      .eq("id", job.id);
    ran += 1;
  }
  return ran;
}
