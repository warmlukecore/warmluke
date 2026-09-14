// ─────────────────────────────────────────────────────────────
// Applying a plan — the only place a design becomes rows.
//
// Two callers: the app, where the owner clicks approve, and the MCP
// tool, where a merchant says yes inside their own assistant. Both go
// through here, and both write through abo_build, so there is one set
// of rules about who may write rather than one per entrance.
//
// Nothing here holds a service-role key. A token carrying client_id
// cannot write directly at all (0028); abo_build lets it through only
// against a request the merchant approved.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { validatePlan } from "@/lib/ai";
import type {
  AssistantPlan,
  FeatureSchema,
  ModuleRow,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

type SchemaJsonWithFeatures = UiSchema & { features?: FeatureSchema | null };
type Db = SupabaseClient;

/** One write, named and checked in the database rather than here. */
type Write = (op: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

const writer =
  (client: Db, projectId: string, requestId: string | null): Write =>
  async (op, payload) => {
    const { data, error } = await client.rpc("abo_build", {
      p_project: projectId,
      p_request: requestId,
      p_op: op,
      p_payload: payload,
    });
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };

export type ApplyOutcome = {
  applied: Array<Record<string, unknown>>;
  errors: string[];
};

/**
 * Runs plans in order — a later plan may point at a section an earlier
 * one created — and stops at the first failure, so a partial run is
 * reported as partial rather than as a success.
 */
export async function applyPlans(
  client: Db,
  projectId: string,
  plans: AssistantPlan[],
  /** The approved request this build is spending, when a client asked. */
  requestId: string | null = null
): Promise<ApplyOutcome> {
  const write = writer(client, projectId, requestId);
  const applied: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  for (const rawPlan of plans.slice(0, 6)) {
    let result: ApplyResult;
    try {
      result = await validateAndApply(client, projectId, rawPlan, write);
    } catch (e) {
      result = { ok: false, errors: [e instanceof Error ? e.message : "Write refused."] };
    }
    if (result.ok) {
      applied.push(result.applied!);
    } else {
      errors.push(...result.errors);
      break;
    }
  }

  return { applied, errors };
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
  rawPlan: AssistantPlan,
  write: Write
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

    // A section over the store needs a store. Checked here rather than
    // trusted to the design: a store can be disconnected between the
    // moment a plan is approved and the moment it is built.
    const sourceTable = plan.newModule.source_table ?? null;
    if (sourceTable) {
      const { data: store } = await client
        .from("stores")
        .select("id")
        .eq("project_id", projectId)
        .eq("status", "connected")
        .maybeSingle();
      if (!store) {
        return {
          ok: false,
          errors: ["No Shopify store is connected to this project, so there are no rows to show."],
        };
      }
    }
    const maxSort = Math.max(0, ...moduleList.map((m) => m.sort_order ?? 0));
    const mod = await write("module_insert", {
      name: plan.newModule.name,
      nav_label: plan.newModule.nav_label,
      icon: plan.newModule.icon || "table",
      route: `/modules/${plan.newModule.name}`,
      sort_order: maxSort + 1,
      parent_id: plan.newModule.parent_id ?? null,
      source_table: sourceTable,
    });

    const schemaJson: SchemaJsonWithFeatures = {
      columns: plan.newSchema.columns,
      features: plan.features ?? null,
    };
    await write("schema_insert", {
      module_id: mod.id,
      schema_json: schemaJson,
      version: 1,
      created_by: "ai",
      change_description: sourceTable
        ? `Showing ${sourceTable.replace("_", " ")} from the connected store`
        : `Created module "${plan.newModule.nav_label}"`,
    });

    if (Array.isArray(plan.newRecords) && plan.newRecords.length > 0) {
      await write("records_insert", { module_id: mod.id, rows: plan.newRecords });
    }

    return {
      ok: true,
      applied: {
        changeType: "NEW_MODULE",
        moduleId: mod.id,
        navLabel: plan.newModule.nav_label,
        ...(sourceTable ? { sourceTable } : {}),
      },
    };
  }

  // ── MODULE_DELETE ───────────────────────────────────────────
  if (plan.changeType === "MODULE_DELETE") {
    await write("module_delete", { module_id: plan.targetModuleId! });
    return { ok: true, applied: { changeType: "MODULE_DELETE", moduleId: plan.targetModuleId } };
  }

  // ── MODULE_UPDATE ───────────────────────────────────────────
  if (plan.changeType === "MODULE_UPDATE") {
    await write("module_update", {
      module_id: plan.targetModuleId!,
      ...(plan.moduleUpdate ?? {}),
    });
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

    await write("schema_insert", {
      module_id: plan.targetModuleId!,
      schema_json: { columns: sj.columns, features: plan.features } as SchemaJsonWithFeatures,
      version: nextVersion,
      created_by: "ai",
      change_description: plan.explanation,
    });
    return { ok: true, applied: { changeType: "FEATURE_UPDATE", moduleId: plan.targetModuleId, version: nextVersion } };
  }

  // ── RECORD_SEED ─────────────────────────────────────────────
  if (plan.changeType === "RECORD_SEED") {
    const rows = plan.newRecords ?? [];
    await write("records_insert", { module_id: plan.targetModuleId!, rows });
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
    await write("automation_delete", { module_id: plan.targetModuleId!, name: auto.name });

    const inserted = await write("automation_insert", {
      module_id: plan.targetModuleId ?? null,
      name: auto.name,
      definition: auto.definition,
    });
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
    const off = await write("automation_disable", { name: plan.automationRemoveName! });
    const disabled = Number(off.count ?? 0);
    if (disabled === 0) {
      return { ok: false, errors: [`No automation named "${plan.automationRemoveName}" in this project.`] };
    }
    return {
      ok: true,
      applied: {
        changeType: "AUTOMATION_REMOVE",
        automationName: plan.automationRemoveName,
        disabled,
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

  await write("schema_insert", {
    module_id: plan.targetModuleId!,
    schema_json: {
      columns: plan.newSchema.columns,
      features: sj.features ?? null,
    } as SchemaJsonWithFeatures,
    version: nextVersion,
    created_by: "ai",
    change_description: plan.explanation,
  });
  return { ok: true, applied: { changeType: plan.changeType, moduleId: plan.targetModuleId, version: nextVersion } };
}
