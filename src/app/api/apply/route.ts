import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { validatePlan } from "@/lib/ai";
import type {
  AssistantPlan,
  FeatureSchema,
  ModuleRow,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

export const runtime = "nodejs";

type SchemaJsonWithFeatures = UiSchema & { features?: FeatureSchema | null };
type Db = NonNullable<Awaited<ReturnType<typeof getUserClient>>>["client"];

/**
 * POST /api/apply — body: { projectId, plans }
 * The ONLY place changes reach the database. Runs under the caller's
 * RLS; re-validates every plan; executes sequentially so later plans
 * can reference modules created by earlier ones (build order).
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { projectId, plans } = (await req.json()) as {
      projectId?: string;
      plans?: AssistantPlan[];
    };
    if (!projectId || !Array.isArray(plans) || plans.length === 0) {
      return NextResponse.json({ error: "projectId and plans are required" }, { status: 400 });
    }
    if (plans.length > 6) plans.length = 6;

    // Verify project ownership via RLS (query returns nothing if not owner).
    const { data: proj } = await client
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .limit(1);
    if (!proj?.[0]) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const applied: Array<Record<string, unknown>> = [];
    const allErrors: string[] = [];

    for (const rawPlan of plans) {
      const result = await validateAndApply(client, projectId, rawPlan);
      if (result.ok) {
        applied.push(result.applied!);
      } else {
        allErrors.push(...result.errors);
        break; // stop at first failure — plans are ordered
      }
    }

    if (applied.length === 0) {
      return NextResponse.json({ applied: false, errors: allErrors }, { status: 422 });
    }

    // Plans run in order and stop at the first failure, so a partial run
    // leaves the rest unbuilt. Reporting only the successes would hand
    // back a half-built feature with no sign that anything was missing.
    if (allErrors.length > 0) {
      return NextResponse.json({
        applied: true,
        partial: true,
        count: applied.length,
        remaining: plans.length - applied.length,
        results: applied,
        errors: allErrors,
      });
    }

    return NextResponse.json({ applied: true, count: applied.length, results: applied });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Rewrites "#slug" module references into real uuids, in place. */
function resolveSlugRefs(plan: AssistantPlan, modules: ModuleRow[]): void {
  const idFor = (ref: unknown): string | null => {
    if (typeof ref !== "string" || !ref.startsWith("#")) return null;
    const slug = ref.slice(1).trim().toLowerCase();
    return modules.find((m) => m.name === slug)?.id ?? null;
  };

  const targetId = idFor(plan.targetModuleId);
  if (targetId) plan.targetModuleId = targetId;

  if (plan.newModule) {
    const p = idFor(plan.newModule.parent_id);
    if (p) plan.newModule.parent_id = p;
  }

  // Link columns name their target the same way, so they resolve here
  // too — a reference site missed by the resolver fails only at apply
  // time, halfway through a build.
  for (const col of plan.newSchema?.columns ?? []) {
    const resolved = idFor(col.linkTo);
    if (resolved) col.linkTo = resolved;
  }
  if (plan.moduleUpdate) {
    const p = idFor(plan.moduleUpdate.parent_id);
    if (p) plan.moduleUpdate.parent_id = p;
  }

  for (const action of plan.automation?.definition?.actions ?? []) {
    if (action.type === "create_record") {
      const resolved = idFor(action.module_id);
      if (resolved) action.module_id = resolved;
    } else if (action.type === "set_fields" && !("self" in action.target)) {
      const resolved = idFor(action.target.module_id);
      if (resolved) action.target.module_id = resolved;
    }
  }
}

type ApplyResult =
  | { ok: true; applied: Record<string, unknown> }
  | { ok: false; errors: string[] };

async function validateAndApply(
  client: Db,
  projectId: string,
  rawPlan: AssistantPlan
): Promise<ApplyResult> {
  // Load live state (RLS-scoped to this owner).
  const { data: modules } = await client
    .from("modules")
    .select("*")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true });
  const moduleList = (modules ?? []) as ModuleRow[];

  // Plans are applied in order, so a later plan often needs to point at a
  // module an earlier plan just created — whose uuid the assistant could
  // not have known. It writes "#section-slug" instead; resolve it now
  // against live state.
  resolveSlugRefs(rawPlan, moduleList);

  let currentSchema: UiSchema | null = null;
  let currentFeatures: FeatureSchema | null = null;
  if (rawPlan.targetModuleId) {
    const { data: rows } = await client
      .from("ui_schemas")
      .select("*")
      .eq("module_id", rawPlan.targetModuleId)
      .order("version", { ascending: false })
      .limit(1);
    const row = rows?.[0] as UiSchemaRow | undefined;
    if (row) {
      const sj = row.schema_json as SchemaJsonWithFeatures;
      currentSchema = { columns: sj.columns };
      currentFeatures = sj.features ?? null;
    }
  }

  const validation = validatePlan(rawPlan, moduleList, currentSchema, currentFeatures);
  if (!validation.ok || !validation.plan) {
    return { ok: false, errors: validation.errors };
  }
  const plan = validation.plan;

  // ── NEW_MODULE ──────────────────────────────────────────────
  if (plan.changeType === "NEW_MODULE") {
    if (!plan.newModule) return { ok: false, errors: ["newModule missing"] };
    const maxSort = Math.max(0, ...moduleList.map((m) => m.sort_order ?? 0));
    const { data: mod, error: insModErr } = await client
      .from("modules")
      .insert({
        project_id: projectId,
        name: plan.newModule.name,
        nav_label: plan.newModule.nav_label,
        icon: plan.newModule.icon || "table",
        route: `/modules/${plan.newModule.name}`,
        sort_order: maxSort + 1,
        parent_id: plan.newModule.parent_id ?? null,
      })
      .select()
      .single();
    if (insModErr) return { ok: false, errors: [insModErr.message] };

    const schemaJson: SchemaJsonWithFeatures = {
      columns: plan.newSchema.columns,
      features: plan.features ?? null,
    };
    const { error: schemaErr } = await client.from("ui_schemas").insert({
      module_id: mod.id,
      schema_json: schemaJson,
      version: 1,
      created_by: "ai",
      change_description: `Created module "${plan.newModule.nav_label}"`,
    });
    if (schemaErr) return { ok: false, errors: [schemaErr.message] };

    if (Array.isArray(plan.newRecords) && plan.newRecords.length > 0) {
      const rows = plan.newRecords.map((data: Record<string, unknown>) => ({
        project_id: projectId,
        module_id: mod.id,
        data,
      }));
      const { error: seedErr } = await client.from("records").insert(rows);
      if (seedErr) return { ok: false, errors: [seedErr.message] };
    }

    return { ok: true, applied: { changeType: "NEW_MODULE", moduleId: mod.id, navLabel: plan.newModule.nav_label } };
  }

  // ── MODULE_DELETE ───────────────────────────────────────────
  if (plan.changeType === "MODULE_DELETE") {
    const { error: delErr } = await client
      .from("modules")
      .delete()
      .eq("id", plan.targetModuleId!);
    if (delErr) return { ok: false, errors: [delErr.message] };
    return { ok: true, applied: { changeType: "MODULE_DELETE", moduleId: plan.targetModuleId } };
  }

  // ── MODULE_UPDATE ───────────────────────────────────────────
  if (plan.changeType === "MODULE_UPDATE") {
    const { error: updErr } = await client
      .from("modules")
      .update(plan.moduleUpdate ?? {})
      .eq("id", plan.targetModuleId!);
    if (updErr) return { ok: false, errors: [updErr.message] };
    return { ok: true, applied: { changeType: "MODULE_UPDATE", moduleId: plan.targetModuleId } };
  }

  // ── FEATURE_UPDATE ──────────────────────────────────────────
  if (plan.changeType === "FEATURE_UPDATE") {
    const { data: latest } = await client
      .from("ui_schemas")
      .select("*")
      .eq("module_id", plan.targetModuleId!)
      .order("version", { ascending: false })
      .limit(1);
    const latestRow = latest?.[0] as UiSchemaRow | undefined;
    const sj = (latestRow?.schema_json ?? { columns: [] }) as SchemaJsonWithFeatures;
    const nextVersion = (latestRow?.version ?? 0) + 1;

    const { error: insertErr } = await client.from("ui_schemas").insert({
      module_id: plan.targetModuleId!,
      schema_json: { columns: sj.columns, features: plan.features } as SchemaJsonWithFeatures,
      version: nextVersion,
      created_by: "ai",
      change_description: plan.explanation,
    });
    if (insertErr) return { ok: false, errors: [insertErr.message] };
    return { ok: true, applied: { changeType: "FEATURE_UPDATE", moduleId: plan.targetModuleId, version: nextVersion } };
  }

  // ── RECORD_SEED ─────────────────────────────────────────────
  if (plan.changeType === "RECORD_SEED") {
    const rows = (plan.newRecords ?? []).map((data: Record<string, unknown>) => ({
      project_id: projectId,
      module_id: plan.targetModuleId!,
      data,
    }));
    const { error: seedErr } = await client.from("records").insert(rows);
    if (seedErr) return { ok: false, errors: [seedErr.message] };
    return { ok: true, applied: { changeType: "RECORD_SEED", moduleId: plan.targetModuleId, seeded: rows.length } };
  }

  // ── AUTOMATION_ADD ──────────────────────────────────────────
  // Business logic is stored as data. A Postgres trigger executes it on
  // every record write, so the rule holds for app edits and API writes
  // alike — nothing here generates code.
  if (plan.changeType === "AUTOMATION_ADD") {
    const auto = plan.automation!;
    // Re-adding a rule by the same name replaces it rather than stacking
    // a second copy that would fire twice on the same write.
    const { error: clearErr } = await client
      .from("automations")
      .delete()
      .eq("project_id", projectId)
      .eq("module_id", plan.targetModuleId!)
      .eq("name", auto.name);
    if (clearErr) return { ok: false, errors: [clearErr.message] };

    const { data: inserted, error: autoErr } = await client
      .from("automations")
      .insert({
        project_id: projectId,
        module_id: plan.targetModuleId,
        name: auto.name,
        enabled: true,
        definition: auto.definition,
      })
      .select("id")
      .single();
    if (autoErr) return { ok: false, errors: [autoErr.message] };
    return {
      ok: true,
      applied: {
        changeType: "AUTOMATION_ADD",
        moduleId: plan.targetModuleId,
        automationId: inserted.id,
        automationName: auto.name,
      },
    };
  }

  // ── AUTOMATION_REMOVE ───────────────────────────────────────
  // Disabled, not deleted: the run log stays readable so the owner can
  // still see what the rule did while it was live.
  if (plan.changeType === "AUTOMATION_REMOVE") {
    const { data: off, error: offErr } = await client
      .from("automations")
      .update({ enabled: false })
      .eq("project_id", projectId)
      .eq("name", plan.automationRemoveName!)
      .select("id");
    if (offErr) return { ok: false, errors: [offErr.message] };
    if (!off || off.length === 0) {
      return { ok: false, errors: [`No automation named "${plan.automationRemoveName}" in this project.`] };
    }
    return {
      ok: true,
      applied: {
        changeType: "AUTOMATION_REMOVE",
        automationName: plan.automationRemoveName,
        disabled: off.length,
      },
    };
  }

  // ── UI_CHANGE / FIELD_ADD ───────────────────────────────────
  // Everything else has returned by now. Guarding here stops an
  // unhandled change type from falling through and overwriting the
  // module's columns with whatever newSchema happened to contain.
  if (plan.changeType !== "UI_CHANGE" && plan.changeType !== "FIELD_ADD") {
    return { ok: false, errors: [`Change type "${plan.changeType}" is not supported yet.`] };
  }

  const { data: latest } = await client
    .from("ui_schemas")
    .select("*")
    .eq("module_id", plan.targetModuleId!)
    .order("version", { ascending: false })
    .limit(1);
  const latestRow = latest?.[0] as UiSchemaRow | undefined;
  const sj = (latestRow?.schema_json ?? { columns: [] }) as SchemaJsonWithFeatures;
  const nextVersion = (latestRow?.version ?? 0) + 1;

  const { error: insertErr } = await client.from("ui_schemas").insert({
    module_id: plan.targetModuleId!,
    schema_json: {
      columns: plan.newSchema.columns,
      features: sj.features ?? null,
    } as SchemaJsonWithFeatures,
    version: nextVersion,
    created_by: "ai",
    change_description: plan.explanation,
  });
  if (insertErr) return { ok: false, errors: [insertErr.message] };
  return { ok: true, applied: { changeType: plan.changeType, moduleId: plan.targetModuleId, version: nextVersion } };
}
