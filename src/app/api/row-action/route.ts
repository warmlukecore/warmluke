import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "@/lib/supabase-server";
import { Refused, writeRecord } from "@/lib/record-write";
import { runCodeRules } from "@/lib/code-rules";
import { actionNamed, actionOn } from "@/lib/row-approval";
import { STORE_TABLES, isStoreTable } from "@/lib/store-read";
import type { FeatureSchema, SchemaColumn, UiSchema } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/row-action — a row's button that waits for the owner (0183,
 * lib/row-approval.ts).
 *
 *   { projectId, moduleId, recordId | storeRowId, label }
 *     Pressed. What it does is worked out here, from the row as it stands,
 *     never from the browser. The owner's press, or any press of a button
 *     that needs no yes, is made at once through the one door; a
 *     teammate's press of one that does waits in the owner's bell.
 *
 *   { projectId, approvalId, decision: "approve" | "decline" }
 *     The owner's word on one that waits. Approved, the change is worked
 *     out again from the row as it is now (a date it stamps is today's)
 *     and made under the owner's own rights; a row that no longer shows
 *     the button is told so, and nothing changes. Only the owner decides,
 *     and only here: the database refuses anyone else and any AI's token.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const body = (await req.json()) as Record<string, unknown>;
    const out = typeof body.approvalId === "string" ? await decide(auth.client, body) : await press(auth.client, body);
    return NextResponse.json(out.body, { status: out.status });
  } catch (e) {
    if (e instanceof Refused) return NextResponse.json({ error: e.message, refused: true }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Something went wrong." }, { status: 500 });
  }
}

const answer = (body: Record<string, unknown>, status = 200) => ({ status, body });

/** The row as the owner will know it in the bell: its first two fields that say something. */
const rowLabel = (columns: SchemaColumn[], row: Record<string, unknown>) =>
  columns
    .filter((c) => !c.hidden && c.type !== "link" && c.type !== "boolean")
    .map((c) => row[c.field])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .slice(0, 2)
    .map((v) => String(v).slice(0, 50))
    .join(" · ");
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The section's fields and buttons, and the row as it stands now (the store's fields under theirs). */
async function rowNow(
  client: SupabaseClient,
  projectId: string,
  moduleId: string,
  recordId: string | null,
  storeRowId: string | null
) {
  const { data: mod } = await client
    .from("modules")
    .select("source_table")
    .eq("id", moduleId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!mod) return null;
  const { data: ui } = await client
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", moduleId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const schema = (ui?.schema_json ?? null) as (UiSchema & { features?: FeatureSchema | null }) | null;
  const columns: SchemaColumn[] = schema?.columns ?? [];
  const table = isStoreTable(mod.source_table) ? mod.source_table : null;
  let row: Record<string, unknown> | null = null;
  if (recordId) {
    const { data: rec } = await client
      .from("records")
      .select("data")
      .eq("id", recordId)
      .eq("module_id", moduleId)
      .maybeSingle();
    row = (rec?.data as Record<string, unknown> | undefined) ?? null;
  } else if (table && storeRowId) {
    const spec = STORE_TABLES[table];
    const { data: theirs } = await client.from(spec.view).select(spec.select).eq("id", storeRowId).maybeSingle();
    const { data: own } = await client
      .from("records")
      .select("data")
      .eq("module_id", moduleId)
      .eq("store_row_id", storeRowId)
      .maybeSingle();
    row = theirs
      ? { ...(theirs as unknown as Record<string, unknown>), ...(own?.data as Record<string, unknown> | undefined) }
      : null;
  }
  return { table, columns, features: schema?.features ?? null, row };
}

/** The change made, through the one door every write uses, its code rules after. */
const make = (
  client: SupabaseClient,
  projectId: string,
  moduleId: string,
  table: string | null,
  recordId: string | null,
  storeRowId: string | null,
  set: Record<string, unknown>
) =>
  writeRecord(
    client,
    {
      projectId,
      moduleId,
      ...(table && storeRowId
        ? { action: "update_store_row" as const, storeRowId }
        : { action: "update" as const, recordId: recordId ?? undefined }),
      data: set,
    },
    (w) => after(() => runCodeRules(client, w))
  );

async function press(client: SupabaseClient, body: Record<string, unknown>) {
  const projectId = text(body.projectId);
  const moduleId = text(body.moduleId);
  const label = text(body.label);
  const recordId = text(body.recordId);
  const storeRowId = text(body.storeRowId);
  if (!projectId || !moduleId || !label || (!recordId && !storeRowId)) {
    return answer({ error: "projectId, moduleId, label and a row are needed." }, 400);
  }
  const now = await rowNow(client, projectId, moduleId, recordId, storeRowId);
  if (!now?.row) return answer({ error: "That row is not there." }, 404);
  const action = actionNamed(now.features, label);
  if (!action) return answer({ error: `This section has no “${label}” button.` }, 404);
  const set = actionOn(action, now.columns, now.row);
  if (!set) return answer({ error: `“${label}” does not apply to this row now.` }, 409);
  const { data: owns } = await client.rpc("abo_owns", { p: projectId });
  if (!action.approval || owns === true) {
    const out = await make(client, projectId, moduleId, now.table, recordId, storeRowId, set);
    return answer({ ...out.body, ...(out.status === 200 ? { done: true } : {}) }, out.status);
  }
  const { data: id, error } = await client.rpc("abo_ask_approval", {
    p_project: projectId,
    p_module: moduleId,
    p_record: recordId,
    p_store_row: storeRowId,
    p_action: label,
    p_set: set,
    p_row_label: rowLabel(now.columns, now.row),
  });
  if (error) return answer({ error: error.message }, error.code === "42501" ? 403 : 500);
  return answer({ waiting: true, approvalId: id });
}

async function decide(client: SupabaseClient, body: Record<string, unknown>) {
  const approvalId = text(body.approvalId);
  const decision = body.decision === "approve" ? "approve" : body.decision === "decline" ? "decline" : null;
  if (!approvalId || !decision) return answer({ error: "approvalId and a decision are needed." }, 400);
  const { data: asked } = await client.from("row_approvals").select("*").eq("id", approvalId).maybeSingle();
  if (!asked) return answer({ error: "That request is not there." }, 404);
  if (asked.status !== "waiting")
    return answer({ error: "That request was already decided.", status: asked.status }, 409);
  const said = async (status: "approved" | "declined" | "stale") => {
    const { data, error } = await client.rpc("abo_decide_approval", { p_id: approvalId, p_status: status });
    if (error) return error.code === "42501" ? "refused" : "failed";
    return data ? "ok" : "refused";
  };
  if (decision === "decline") {
    const r = await said("declined");
    return r === "ok" ? answer({ declined: true }) : answer({ error: "Only the owner decides." }, 403);
  }
  const now = await rowNow(client, asked.project_id, asked.module_id, asked.record_id, asked.store_row_id);
  const action = now?.row ? actionNamed(now.features, asked.action) : null;
  const set = action && now?.row ? actionOn(action, now.columns, now.row) : null;
  if (!now || !set) {
    const r = await said("stale");
    return r === "ok"
      ? answer({ stale: true, said: `The row no longer shows “${asked.action}”, so nothing was changed.` })
      : answer({ error: "Only the owner decides." }, 403);
  }
  const r = await said("approved");
  if (r !== "ok") return answer({ error: "Only the owner decides." }, 403);
  const out = await make(
    client,
    asked.project_id,
    asked.module_id,
    now.table,
    asked.record_id,
    asked.store_row_id,
    set
  );
  return answer({ ...out.body, ...(out.status === 200 ? { done: true } : {}) }, out.status);
}
