import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { STORE_TABLES, canCarryOwnFields, isStoreTable, ownColumns } from "@/lib/store-read";
import type { FeatureSchema, SchemaColumn, UiSchema, UiSchemaRow } from "@/lib/types";

export const runtime = "nodejs";

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

/**
 * POST /api/records — body: { action, projectId, moduleId, recordId?, storeRowId?, data? }
 *
 * "update_store_row" keeps the merchant's own fields beside one of the
 * store's rows (0128): only the section's own columns, only on a row of
 * this project's store, one record per row, merged like any update.
 * The owner's own writes. Runs under their RLS, and every field is
 * checked against the module's current schema before it lands.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { client } = auth;

    const { action, projectId, moduleId, recordId, storeRowId, data } = (await req.json()) as {
      action?: "create" | "update" | "delete" | "update_store_row";
      projectId?: string;
      moduleId?: string;
      recordId?: string;
      storeRowId?: string;
      data?: Record<string, unknown>;
    };

    if (!action || !projectId || !moduleId) {
      return NextResponse.json({ error: "action, projectId and moduleId are required" }, { status: 400 });
    }

    // RLS returns nothing for a module the caller doesn't own.
    const { data: mods } = await client
      .from("modules")
      .select("id, source_table")
      .eq("id", moduleId)
      .eq("project_id", projectId)
      .limit(1);
    if (!mods?.[0]) {
      return NextResponse.json({ error: "Section not found." }, { status: 404 });
    }
    const source = (mods[0].source_table as string | null) ?? null;
    // A section over the store has the store's rows: none are added or
    // taken away here, and its own fields go beside a row (below).
    if (source && action !== "update_store_row") {
      return NextResponse.json(
        { error: "The rows of this section are your store's: they are added and removed in Shopify." },
        { status: 400 }
      );
    }
    if (!source && action === "update_store_row") {
      return NextResponse.json({ error: "This section's rows are your own, not the store's." }, { status: 400 });
    }

    if (action === "delete") {
      if (!recordId) {
        return NextResponse.json({ error: "recordId is required" }, { status: 400 });
      }
      const { error } = await client.from("records").delete().eq("id", recordId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, deleted: recordId });
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
      return NextResponse.json({ error: "This section has no fields yet." }, { status: 400 });
    }

    // On a store section only the merchant's own columns are written:
    // the store's are the import's, and a computed one is never stored.
    const table = source && isStoreTable(source) ? source : null;
    if (source && (!table || !canCarryOwnFields(table))) {
      return NextResponse.json({ error: "This list's rows cannot hold fields of your own." }, { status: 400 });
    }
    const writable = table ? ownColumns(table, columns) : columns;
    if (table && writable.length === 0) {
      return NextResponse.json({ error: "This section has no fields of your own yet." }, { status: 400 });
    }
    const clean = cleanData(writable, data);
    // The row as it stands once the rules on it have run: RETURNING
    // shows the write, not what an after-trigger set on the same row,
    // and the browser places this row instead of reloading the section.
    const fresh = async (id: string) => {
      const { data: row, error } = await client.from("records").select("*").eq("id", id).single();
      if (error) throw new Error(error.message);
      return row;
    };

    // A link is only meaningful if it points at a row that exists in
    // the section the column names; anything else silently renders as
    // "(deleted)" forever.
    for (const col of writable) {
      if (col.type !== "link") continue;
      const id = clean[col.field];
      if (!id || typeof id !== "string") continue;
      const { data: target } = await client
        .from("records")
        .select("id")
        .eq("id", id)
        .eq("module_id", col.linkTo ?? "")
        .limit(1);
      if (!target?.[0]) {
        return NextResponse.json(
          { error: `"${col.label}" points at a row that isn't in the linked section.` },
          { status: 400 }
        );
      }
    }

    if (action === "create") {
      const { data: created, error } = await client
        .from("records")
        .insert({ project_id: projectId, module_id: moduleId, data: clean })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, record: await fresh(created.id) });
    }

    if (action === "update") {
      if (!recordId) {
        return NextResponse.json({ error: "recordId is required" }, { status: 400 });
      }
      // Merge rather than replace: a partial edit (a row action setting one
      // field) must not blank out everything it didn't mention.
      const { data: existing } = await client.from("records").select("data").eq("id", recordId).limit(1);
      const prev = (existing?.[0]?.data ?? {}) as Record<string, unknown>;

      const { error } = await client
        .from("records")
        .update({ data: { ...prev, ...clean }, updated_at: new Date().toISOString() })
        .eq("id", recordId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, record: await fresh(recordId) });
    }

    if (action === "update_store_row" && table) {
      if (!storeRowId || !UUID.test(storeRowId)) {
        return NextResponse.json({ error: "storeRowId is required" }, { status: 400 });
      }
      if (Object.keys(clean).length === 0) {
        return NextResponse.json({ error: "Nothing to keep: those fields are the store's." }, { status: 400 });
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
        return NextResponse.json({ error: "That row is not in your store's list." }, { status: 404 });
      }
      const merge = async () => {
        const { data: have } = await client
          .from("records")
          .select("id, data")
          .eq("module_id", moduleId)
          .eq("store_row_id", storeRowId)
          .maybeSingle();
        if (!have) return null;
        const { error } = await client
          .from("records")
          .update({
            data: { ...((have.data ?? {}) as Record<string, unknown>), ...clean },
            updated_at: new Date().toISOString(),
          })
          .eq("id", have.id);
        if (error) throw new Error(error.message);
        return fresh(have.id as string);
      };
      const merged = await merge();
      if (merged) return NextResponse.json({ ok: true, record: merged });
      const { data: created, error } = await client
        .from("records")
        .insert({ project_id: projectId, module_id: moduleId, store_row_id: storeRowId, data: clean })
        .select("id")
        .single();
      // Two tabs keeping the first field of the same row at once: the
      // one that lost the insert merges into the one that won.
      if (error?.code === "23505") return NextResponse.json({ ok: true, record: await merge() });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, record: await fresh(created.id) });
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
