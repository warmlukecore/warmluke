// One door for a section's own writes: create, update, delete, and the
// merchant's fields kept beside a store row (0128). The records route
// opens it for the browser; a rule's own code (lib/code-rules.ts) comes
// through the same one, so every write is held to the same schema, the
// same own-fields line and the same rights, whoever makes it.
//
// Callers: src/app/api/records/route.ts, src/lib/code-rules.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { STORE_TABLES, canCarryOwnFields, isStoreTable, ownColumns, type StoreTable } from "@/lib/store-read";
import type { FeatureSchema, SchemaColumn, UiSchema, UiSchemaRow } from "@/lib/types";
import { approvalNeededFor } from "@/lib/row-approval";

type SchemaJsonWithFeatures = UiSchema & { features?: FeatureSchema | null };

/**
 * Values arrive as strings from form inputs. Storing "12" where the
 * schema says number would break every sum, filter and automation that
 * reads it, so coerce against the column type on the way in.
 */
function coerce(col: SchemaColumn, raw: unknown): unknown {
  if (col.type === "link") return raw === null || raw === undefined ? "" : String(raw).trim();
  if (col.type === "boolean") {
    return raw === true || raw === "true" || raw === "yes" || raw === 1;
  }
  if (raw === null || raw === undefined || raw === "") return "";
  if (col.type === "number" || col.type === "currency" || col.type === "percent") {
    const n = Number(raw);
    return Number.isNaN(n) ? String(raw) : n;
  }
  return String(raw).trim();
}

/** Drops anything the schema doesn't declare — the UI is not the authority. */
function cleanData(columns: SchemaColumn[], input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof input !== "object" || input === null) return out;
  const src = input as Record<string, unknown>;
  for (const col of columns) {
    if (col.field in src) out[col.field] = coerce(col, src[col.field]);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WriteInput = {
  action?: "create" | "update" | "delete" | "update_store_row";
  projectId?: string;
  moduleId?: string;
  recordId?: string;
  storeRowId?: string;
  data?: Record<string, unknown>;
  /** On an update: the fields being changed, as the person saw them (0149). */
  expected?: Record<string, unknown>;
};

/** A row written, as a rule that runs on it needs to know it. */
export type Written = {
  event: "created" | "updated";
  projectId: string;
  moduleId: string;
  /** The records row as it stands after its database rules ran. */
  record: Record<string, unknown>;
  /** Its fields before this write, on an update. */
  previous: Record<string, unknown> | null;
  /** The store's list the section shows, and the store row, on a section over the store. */
  table: StoreTable | null;
  storeRowId: string | null;
  columns: SchemaColumn[];
};

const reply = (body: Record<string, unknown>, init?: { status: number }) => ({ status: init?.status ?? 200, body });

/**
 * A save a rule refused (0143, a before_save rule): the rule's own
 * sentence, and nothing was written. Not a failure of the app, so the
 * door answers 409 with it rather than 500, and a screen says it as it is.
 */
export class Refused extends Error {}

/** The database's refusal as a Refused, anything else as the error it is. */
function writeError(error: { message: string; hint?: string | null }): Error {
  return error.hint === "abo_refused" ? new Refused(error.message) : new Error(error.message);
}

/**
 * A write to a section — body: { action, projectId, moduleId, recordId?, storeRowId?, data? }
 *
 * "update_store_row" keeps the merchant's own fields beside one of the
 * store's rows (0128): only the section's own columns, only on a row of
 * this project's store, one record per row, merged like any update.
 * The owner's own writes. Runs under their RLS, and every field is
 * checked against the module's current schema before it lands.
 */
export async function writeRecord(
  client: SupabaseClient,
  input: WriteInput,
  /** Told of each row written, after the write stands. */
  written?: (w: Written) => void
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { action, projectId, moduleId, recordId, storeRowId, data, expected } = input;

  if (!action || !projectId || !moduleId) {
    return reply({ error: "action, projectId and moduleId are required" }, { status: 400 });
  }

  // RLS returns nothing for a module the caller doesn't own.
  const { data: mods } = await client
    .from("modules")
    .select("id, source_table")
    .eq("id", moduleId)
    .eq("project_id", projectId)
    .limit(1);
  if (!mods?.[0]) {
    return reply({ error: "Section not found." }, { status: 404 });
  }
  const source = (mods[0].source_table as string | null) ?? null;
  // A section over the store has the store's rows: none are added or
  // taken away here, and its own fields go beside a row (below).
  if (source && action !== "update_store_row") {
    return reply(
      { error: "The rows of this section are your store's: they are added and removed in Shopify." },
      { status: 400 }
    );
  }
  if (!source && action === "update_store_row") {
    return reply({ error: "This section's rows are your own, not the store's." }, { status: 400 });
  }

  if (action === "delete") {
    if (!recordId) {
      return reply({ error: "recordId is required" }, { status: 400 });
    }
    const { error } = await client.from("records").delete().eq("id", recordId);
    if (error) throw writeError(error);
    return reply({ ok: true, deleted: recordId });
  }

  const { data: schemaRows } = await client
    .from("ui_schemas")
    .select("*")
    .eq("module_id", moduleId)
    .order("version", { ascending: false })
    .limit(1);
  const schemaRow = schemaRows?.[0] as UiSchemaRow | undefined;
  const columns = (schemaRow?.schema_json as SchemaJsonWithFeatures | undefined)?.columns ?? [];
  if (columns.length === 0) {
    return reply({ error: "This section has no fields yet." }, { status: 400 });
  }

  // On a store section only the merchant's own columns are written:
  // the store's are the import's, and a computed one is never stored.
  const table = source && isStoreTable(source) ? source : null;
  if (source && (!table || !canCarryOwnFields(table))) {
    return reply({ error: "This list's rows cannot hold fields of your own." }, { status: 400 });
  }
  const writable = table ? ownColumns(table, columns) : columns;
  if (table && writable.length === 0) {
    return reply({ error: "This section has no fields of your own yet." }, { status: 400 });
  }
  const clean = cleanData(writable, data);

  // A change an approval button makes is the owner's, or waits for their
  // yes (0183, lib/row-approval.ts): a teammate's edit that would make it
  // by hand is refused here, with the button to press instead.
  const features = (schemaRow?.schema_json as SchemaJsonWithFeatures | undefined)?.features ?? null;
  if ((action === "update" || action === "update_store_row") && features?.actions?.some((a) => a.approval)) {
    const { data: owns } = await client.rpc("abo_owns", { p: projectId });
    if (owns !== true) {
      const own = async (q: { id?: string; storeRowId?: string }) => {
        let read = client.from("records").select("data").eq("module_id", moduleId);
        read = q.id ? read.eq("id", q.id) : read.eq("store_row_id", q.storeRowId ?? "");
        const { data: rec } = await read.maybeSingle();
        return ((rec as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
      };
      let previous: Record<string, unknown> = {};
      if (action === "update" && recordId) previous = await own({ id: recordId });
      if (action === "update_store_row" && table && storeRowId) {
        const spec = STORE_TABLES[table];
        const { data: theirs } = await client.from(spec.view).select(spec.select).eq("id", storeRowId).maybeSingle();
        previous = { ...(theirs as Record<string, unknown> | null), ...(await own({ storeRowId })) };
      }
      const label = approvalNeededFor(features, columns, previous, clean);
      if (label) {
        return reply(
          { error: `Only the owner makes this change. Press “${label}” on the row to ask them.`, approval: label },
          { status: 409 }
        );
      }
    }
  }

  const onWritten = written
    ? (w: {
        event: "created" | "updated";
        record: Record<string, unknown>;
        previous: Record<string, unknown> | null;
      }) => written({ ...w, projectId, moduleId, table, columns, storeRowId: table ? (storeRowId ?? null) : null })
    : undefined;
  // The row as it stands once the rules on it have run: RETURNING
  // shows the write, not what an after-trigger set on the same row,
  // and the browser places this row instead of reloading the section.
  const fresh = async (id: string) => {
    const { data: row, error } = await client.from("records").select("*").eq("id", id).single();
    if (error) throw writeError(error);
    return row;
  };

  // The fields sent, onto the row in one step (0149), and the answer when
  // they did not land: gone, or changed since they were seen.
  const patch = async (
    id: string,
    fields: Record<string, unknown>,
    seen: Record<string, unknown> | null
  ): Promise<
    | { status: "applied"; before: Record<string, unknown> }
    | { status: "missing" | "conflict"; answer: { status: number; body: Record<string, unknown> } }
  > => {
    const { data: done, error } = await client.rpc("abo_record_patch", {
      p_record: id,
      p_patch: fields,
      p_expected: seen,
    });
    if (error) throw writeError(error);
    const res = done as { status: string; before?: Record<string, unknown>; now?: Record<string, unknown> };
    if (res.status === "applied") return { status: "applied", before: res.before ?? {} };
    if (res.status === "missing") {
      return { status: "missing", answer: reply({ error: "That row is no longer there." }, { status: 404 }) };
    }
    const label = (f: string) => columns.find((c) => c.field === f)?.label ?? f;
    const shown = (v: unknown) =>
      v === null || v === "" ? "empty" : `“${typeof v === "string" ? v : JSON.stringify(v)}”`;
    const now = Object.entries(res.now ?? {})
      .map(([f, v]) => `${label(f)} is now ${shown(v)}`)
      .join(", ");
    return {
      status: "conflict",
      answer: reply(
        {
          error: `Someone changed this row while you had it open: ${now}. Nothing of yours was saved, and the row shows theirs now.`,
          conflict: true,
          record: await fresh(id),
        },
        { status: 409 }
      ),
    };
  };

  // A link is only meaningful if it points at a row that exists in
  // the section the column names; anything else silently renders as
  // "(deleted)" forever.
  for (const col of writable) {
    if (col.type !== "link") continue;
    const id = clean[col.field];
    if (!id || typeof id !== "string") continue;
    // A section over a store's list points at that store's rows: one of
    // the store this app is connected to, never another's (5 Oct). Before,
    // only rows of their own counted, so no store row could be linked.
    const { data: over } = await client
      .from("modules")
      .select("source_table, project_id")
      .eq("id", col.linkTo ?? "")
      .maybeSingle();
    const table = (over as { source_table?: string | null } | null)?.source_table;
    let there = false;
    if (isStoreTable(table)) {
      const { data: store } = await client
        .from("stores")
        .select("id")
        .eq("project_id", (over as { project_id: string }).project_id)
        .maybeSingle();
      const { data: row } = store
        ? await client.from(STORE_TABLES[table].view).select("id").eq("id", id).eq("store_id", store.id).limit(1)
        : { data: null };
      there = !!row?.[0];
    } else {
      const { data: target } = await client
        .from("records")
        .select("id")
        .eq("id", id)
        .eq("module_id", col.linkTo ?? "")
        .limit(1);
      there = !!target?.[0];
    }
    if (!there) {
      return reply({ error: `"${col.label}" points at a row that isn't in the linked section.` }, { status: 400 });
    }
  }

  if (action === "create") {
    const { data: created, error } = await client
      .from("records")
      .insert({ project_id: projectId, module_id: moduleId, data: clean })
      .select("id")
      .single();
    if (error) throw writeError(error);
    const made = await fresh(created.id);
    onWritten?.({ event: "created", record: made, previous: null });
    return reply({ ok: true, record: made });
  }

  if (action === "update") {
    if (!recordId) {
      return reply({ error: "recordId is required" }, { status: 400 });
    }
    // Only the fields sent change, in one step in the database (0149): a
    // partial edit (a row action setting one field) blanks out nothing it
    // didn't mention, and two people saving the same row at once each
    // keep what they changed. What they saw is compared for just those.
    const seen = expected ? Object.fromEntries(Object.keys(clean).map((f) => [f, expected[f] ?? null])) : null;
    const patched = await patch(recordId, clean, seen);
    if (patched.status !== "applied") return patched.answer;
    const now = await fresh(recordId);
    onWritten?.({ event: "updated", record: now, previous: patched.before });
    return reply({ ok: true, record: now });
  }

  if (action === "update_store_row" && table) {
    if (!storeRowId || !UUID.test(storeRowId)) {
      return reply({ error: "storeRowId is required" }, { status: 400 });
    }
    if (Object.keys(clean).length === 0) {
      return reply({ error: "Nothing to keep: those fields are the store's." }, { status: 400 });
    }
    // One of this project's store's rows, read through its list under
    // the caller's RLS: an id from anywhere else finds nothing.
    const { data: store } = await client
      .from("stores")
      .select("id")
      .eq("project_id", projectId)
      .in("status", ["connected", "uninstalled"])
      .maybeSingle();
    const { data: row } = store
      ? await client
          .from(STORE_TABLES[table].view)
          .select("id")
          .eq("id", storeRowId)
          .eq("store_id", store.id)
          .maybeSingle()
      : { data: null };
    if (!row) {
      return reply({ error: "That row is not in your store's list." }, { status: 404 });
    }
    let before: Record<string, unknown> | null = null;
    // ponytail: no "what you saw" here yet, so the same field saved by two
    // people at once is the last one's; the merge itself is one step (0149).
    const merge = async () => {
      const { data: have } = await client
        .from("records")
        .select("id")
        .eq("module_id", moduleId)
        .eq("store_row_id", storeRowId)
        .maybeSingle();
      if (!have) return null;
      const patched = await patch(have.id as string, clean, null);
      // Gone between the look and the write: it is made again below.
      if (patched.status !== "applied") return null;
      before = patched.before;
      return fresh(have.id as string);
    };
    const kept = (record: Record<string, unknown> | null, event: "created" | "updated") => {
      if (record) onWritten?.({ event, record, previous: before });
      return reply({ ok: true, record });
    };
    const merged = await merge();
    if (merged) return kept(merged, "updated");
    const { data: created, error } = await client
      .from("records")
      .insert({ project_id: projectId, module_id: moduleId, store_row_id: storeRowId, data: clean })
      .select("id")
      .single();
    // Two tabs keeping the first field of the same row at once: the
    // one that lost the insert merges into the one that won.
    if (error?.code === "23505") return kept(await merge(), "updated");
    if (error) throw writeError(error);
    return kept(await fresh(created.id), "created");
  }

  return reply({ error: `Unknown action "${action}".` }, { status: 400 });
}
