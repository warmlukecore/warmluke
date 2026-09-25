import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { ALLOWED_ICONS, COLUMN_TYPES } from "@/lib/types";
import { isStoreTable, storeTableSchema, type StoreTable } from "@/lib/store-read";
import type { AutomationRow, ColumnType, ModuleRow, SchemaColumn } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Rules point at other sections by id inside their JSON definition, and
 * those references are invisible to the database's foreign keys. Deleting
 * a section a rule writes to would leave the rule pointing at nothing —
 * it would keep running and quietly change no rows. So we look first.
 */
async function rulesPointingAt(
  client: NonNullable<Awaited<ReturnType<typeof getUserClient>>>["client"],
  projectId: string,
  moduleId: string
): Promise<string[]> {
  const { data } = await client.from("automations").select("*").eq("project_id", projectId);
  const names: string[] = [];
  for (const a of (data ?? []) as AutomationRow[]) {
    if (a.module_id === moduleId) continue; // goes with the section anyway
    const points = (a.definition?.actions ?? []).some((act) => {
      if (act.type === "create_record") return act.module_id === moduleId;
      if (act.type === "set_fields" && !("self" in act.target)) {
        return act.target.module_id === moduleId;
      }
      return false;
    });
    if (points) names.push(a.name);
  }
  return names;
}

/** "Drop-off date" -> "drop_off_date". */
function toFieldName(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field"
  );
}

function toSlug(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "section"
  );
}

/**
 * POST /api/modules — create a section by hand, optionally inside
 * another. Naming a section shouldn't need the assistant.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { client } = auth;

  const { projectId, nav_label, icon, parent_id, fields, source_table } = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    nav_label?: string;
    icon?: string;
    parent_id?: string | null;
    fields?: Array<{ label: string; type: string }>;
    /** Create the section already pointed at a store table. */
    source_table?: string | null;
  };

  if (!projectId || !nav_label?.trim()) {
    return NextResponse.json({ error: "projectId and a name are required" }, { status: 400 });
  }
  const label = nav_label.trim().slice(0, 60);
  const chosenIcon = icon && (ALLOWED_ICONS as readonly string[]).includes(icon) ? icon : "table";

  // A section built on the store takes its columns from the store, not
  // from whatever fields the caller sent: the two have to agree or the
  // rows render into columns that do not exist.
  if (source_table != null && !isStoreTable(source_table)) {
    return NextResponse.json({ error: "That isn't a store table." }, { status: 400 });
  }
  if (source_table != null) {
    const { data: store } = await client
      .from("stores")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "connected")
      .maybeSingle();
    if (!store) {
      return NextResponse.json({ error: "No Shopify store is connected to this project yet." }, { status: 409 });
    }
  }

  const columns: SchemaColumn[] = source_table != null ? storeTableSchema(source_table).columns : [];
  const seen = new Set<string>();
  for (const f of source_table != null ? [] : (fields ?? [])) {
    if (!f?.label?.trim()) continue;
    if (!(COLUMN_TYPES as readonly string[]).includes(f.type)) {
      return NextResponse.json({ error: `"${f.type}" isn't a field type.` }, { status: 400 });
    }
    let name = toFieldName(f.label);
    while (seen.has(name)) name = `${name}_2`;
    seen.add(name);
    columns.push({ field: name, label: f.label.trim().slice(0, 60), type: f.type as ColumnType });
  }
  // A section with no columns renders as nothing at all, so give a new
  // one something to hold until the owner or the assistant adds more.
  if (columns.length === 0) {
    columns.push({ field: "name", label: "Name", type: "text" });
  }

  if (parent_id) {
    const { data: parent } = await client
      .from("modules")
      .select("id, parent_id, nav_label")
      .eq("id", parent_id)
      .eq("project_id", projectId)
      .limit(1);
    const p = parent?.[0] as Pick<ModuleRow, "id" | "parent_id" | "nav_label"> | undefined;
    if (!p) return NextResponse.json({ error: "That section doesn't exist." }, { status: 400 });
    if (p.parent_id) {
      return NextResponse.json(
        { error: `"${p.nav_label}" is already inside another section — nesting only goes one level.` },
        { status: 400 }
      );
    }
  }

  // Slugs are unique per project, so make room for a second "Notes".
  const { data: existing } = await client.from("modules").select("name, sort_order").eq("project_id", projectId);
  const taken = new Set((existing ?? []).map((m) => (m as ModuleRow).name));
  const base = toSlug(label);
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const maxSort = Math.max(0, ...(existing ?? []).map((m) => (m as ModuleRow).sort_order ?? 0));

  const { data: created, error } = await client
    .from("modules")
    .insert({
      project_id: projectId,
      name: slug,
      nav_label: label,
      icon: chosenIcon,
      route: `/modules/${slug}`,
      sort_order: maxSort + 1,
      parent_id: parent_id ?? null,
      source_table: source_table ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: schemaErr } = await client.from("ui_schemas").insert({
    module_id: created.id,
    schema_json: { columns, features: null },
    version: 1,
    created_by: "user",
    change_description: source_table
      ? `Showing ${source_table.replace("_", " ")} from the connected store`
      : `Created section "${label}"`,
  });
  if (schemaErr) {
    // Without a schema the section would render as nothing; don't leave
    // a broken one behind.
    await client.from("modules").delete().eq("id", created.id);
    return NextResponse.json({ error: schemaErr.message }, { status: 500 });
  }

  return NextResponse.json({ module: created });
}

/**
 * PATCH /api/modules — rename a section, change its icon, move it in the
 * sidebar, or nest it under another. Only the fields sent are touched.
 */
export async function PATCH(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { client } = auth;

  const { id, projectId, nav_label, icon, sort_order, parent_id, source_table } = (await req
    .json()
    .catch(() => ({}))) as {
    id?: string;
    projectId?: string;
    nav_label?: string;
    icon?: string;
    sort_order?: number;
    /** null moves it back to the top level. */
    parent_id?: string | null;
    /** A store table to show instead of this section's own rows. */
    source_table?: string | null;
  };
  if (!id || !projectId) {
    return NextResponse.json({ error: "id and projectId are required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (nav_label !== undefined) {
    const trimmed = nav_label.trim();
    if (!trimmed) return NextResponse.json({ error: "A section needs a name." }, { status: 400 });
    patch.nav_label = trimmed.slice(0, 60);
  }
  if (icon !== undefined) {
    if (!(ALLOWED_ICONS as readonly string[]).includes(icon)) {
      return NextResponse.json({ error: `"${icon}" isn't an available icon.` }, { status: 400 });
    }
    patch.icon = icon;
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== "number" || !Number.isFinite(sort_order)) {
      return NextResponse.json({ error: "sort_order must be a number." }, { status: 400 });
    }
    patch.sort_order = sort_order;
  }
  if (parent_id !== undefined) {
    if (parent_id === id) {
      return NextResponse.json({ error: "A section can't sit under itself." }, { status: 400 });
    }
    if (parent_id !== null) {
      const { data: parent } = await client
        .from("modules")
        .select("id, parent_id, nav_label")
        .eq("id", parent_id)
        .eq("project_id", projectId)
        .limit(1);
      const p = parent?.[0] as Pick<ModuleRow, "id" | "parent_id" | "nav_label"> | undefined;
      if (!p) return NextResponse.json({ error: "That section doesn't exist." }, { status: 400 });
      if (p.parent_id) {
        return NextResponse.json(
          { error: `"${p.nav_label}" is already inside another section — nesting only goes one level.` },
          { status: 400 }
        );
      }
      const { data: kids } = await client.from("modules").select("id").eq("parent_id", id).limit(1);
      if (kids?.[0]) {
        return NextResponse.json(
          { error: "This section has sections inside it, so it can't be moved into another." },
          { status: 400 }
        );
      }
    }
    patch.parent_id = parent_id;
  }
  // Pointing a section at the store, or back at its own rows. The
  // columns are written after the module is updated, not before: a
  // schema saved beside a module that then failed to update would show
  // the store's columns over the section's own rows.
  let storeSchemaFor: StoreTable | null = null;
  if (source_table !== undefined) {
    if (source_table !== null && !isStoreTable(source_table)) {
      return NextResponse.json({ error: "That isn't a store table." }, { status: 400 });
    }
    if (source_table !== null) {
      const { data: store } = await client
        .from("stores")
        .select("id")
        .eq("project_id", projectId)
        .eq("status", "connected")
        .maybeSingle();
      if (!store) {
        return NextResponse.json({ error: "No Shopify store is connected to this project yet." }, { status: 409 });
      }
      storeSchemaFor = source_table;
    }
    patch.source_table = source_table;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await client.from("modules").update(patch).eq("id", id).eq("project_id", projectId).select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "Section not found." }, { status: 404 });

  if (storeSchemaFor) {
    // The columns have to change with the source, or the section shows
    // blank cells for fields the store rows do not have. A new version,
    // so the section's own columns are still in history and come back
    // if it is pointed at its own rows again.
    const { data: latest } = await client
      .from("ui_schemas")
      .select("version")
      .eq("module_id", id)
      .order("version", { ascending: false })
      .limit(1);
    const { error: sErr } = await client.from("ui_schemas").insert({
      module_id: id,
      version: ((latest?.[0]?.version as number) ?? 0) + 1,
      schema_json: { ...storeTableSchema(storeSchemaFor), features: null },
      created_by: "user",
      change_description: `Showing ${storeSchemaFor.replace("_", " ")} from the connected store`,
    });
    if (sErr) {
      // Put it back rather than leave a section claiming a source whose
      // columns never arrived.
      await client.from("modules").update({ source_table: null }).eq("id", id);
      return NextResponse.json({ error: sErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ module: data[0] });
}

/**
 * DELETE /api/modules — remove a section, its rows, its history and any
 * sections nested inside it. `confirmName` must match its label.
 */
export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { client } = auth;

  const { id, projectId, confirmName } = (await req.json().catch(() => ({}))) as {
    id?: string;
    projectId?: string;
    confirmName?: string;
  };
  if (!id || !projectId) {
    return NextResponse.json({ error: "id and projectId are required" }, { status: 400 });
  }

  const { data: found } = await client
    .from("modules")
    .select("id, nav_label")
    .eq("id", id)
    .eq("project_id", projectId)
    .limit(1);
  const mod = found?.[0] as Pick<ModuleRow, "id" | "nav_label"> | undefined;
  if (!mod) return NextResponse.json({ error: "Section not found." }, { status: 404 });

  if ((confirmName ?? "").trim().toLowerCase() !== mod.nav_label.trim().toLowerCase()) {
    return NextResponse.json({ error: "Type the section's name exactly to delete it." }, { status: 400 });
  }

  const orphaned = await rulesPointingAt(client, projectId, id);
  if (orphaned.length > 0) {
    return NextResponse.json(
      {
        error: `These rules write to "${mod.nav_label}" and would stop working: ${orphaned.join(", ")}. Turn them off first.`,
        blockedBy: orphaned,
      },
      { status: 409 }
    );
  }

  const { error } = await client.from("modules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: id });
}

/** GET /api/modules?projectId=…&id=… — what deleting this would take. */
export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const id = url.searchParams.get("id");
  if (!projectId || !id) {
    return NextResponse.json({ error: "projectId and id are required" }, { status: 400 });
  }

  const [{ count: records }, { data: children }] = await Promise.all([
    auth.client.from("records").select("id", { count: "exact", head: true }).eq("module_id", id),
    auth.client.from("modules").select("id, nav_label").eq("parent_id", id),
  ]);

  return NextResponse.json({
    records: records ?? 0,
    children: (children ?? []) as Array<{ id: string; nav_label: string }>,
    blockedBy: await rulesPointingAt(auth.client, projectId, id),
  });
}
