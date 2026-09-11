import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
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

/**
 * POST /api/records — body: { action, projectId, moduleId, recordId?, data? }
 * The owner's own writes. Runs under their RLS, and every field is
 * checked against the module's current schema before it lands.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { client } = auth;

    const { action, projectId, moduleId, recordId, data } = (await req.json()) as {
      action?: "create" | "update" | "delete";
      projectId?: string;
      moduleId?: string;
      recordId?: string;
      data?: Record<string, unknown>;
    };

    if (!action || !projectId || !moduleId) {
      return NextResponse.json(
        { error: "action, projectId and moduleId are required" },
        { status: 400 }
      );
    }

    // RLS returns nothing for a module the caller doesn't own.
    const { data: mods } = await client
      .from("modules")
      .select("id")
      .eq("id", moduleId)
      .eq("project_id", projectId)
      .limit(1);
    if (!mods?.[0]) {
      return NextResponse.json({ error: "Section not found." }, { status: 404 });
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

    const clean = cleanData(columns, data);

    // A link is only meaningful if it points at a row that exists in
    // the section the column names; anything else silently renders as
    // "(deleted)" forever.
    for (const col of columns) {
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
        .select()
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, record: created });
    }

    if (action === "update") {
      if (!recordId) {
        return NextResponse.json({ error: "recordId is required" }, { status: 400 });
      }
      // Merge rather than replace: a partial edit (a row action setting one
      // field) must not blank out everything it didn't mention.
      const { data: existing } = await client
        .from("records")
        .select("data")
        .eq("id", recordId)
        .limit(1);
      const prev = (existing?.[0]?.data ?? {}) as Record<string, unknown>;

      const { data: updated, error } = await client
        .from("records")
        .update({ data: { ...prev, ...clean }, updated_at: new Date().toISOString() })
        .eq("id", recordId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, record: updated });
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
