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
 * How to put one write back, and what to say if it cannot be.
 *
 * Every write goes through one RPC, so an undo is the same RPC with
 * the opposite op — which is the only reason this is small enough to
 * be worth having.
 */
type Undo =
  | { kind: "op"; op: string; payload: Record<string, unknown> }
  | { kind: "stranded"; what: string };

/**
 * Records how to reverse each write as it happens.
 *
 * A batch is several RPCs, and PostgREST gives each one its own
 * transaction: there is no way to ask the database to hold six of them
 * open together. So the undo is built here instead, one entry per
 * write, and replayed backwards if a later plan fails.
 *
 * Reversed order matters even where the database would cascade: a
 * section's schema and rules are put back before the section itself is
 * removed, so this does not depend on which foreign keys happen to
 * cascade.
 *
 * Two writes have no opposite — rows seeded into a section that already
 * existed, and a rule switched off — so they are recorded as stranded
 * and said out loud rather than quietly left behind.
 */
function recording(client: Db, projectId: string, write: Write, undo: Undo[]): Write {
  return async (op, payload) => {
    // Anything needed to undo this write has to be read before it
    // happens; afterwards the old value is already gone.
    let before: Record<string, unknown> | null = null;
    if (op === "schema_insert") {
      const { data } = await client
        .from("ui_schemas")
        .select("schema_json, version")
        .eq("module_id", payload.module_id as string)
        .order("version", { ascending: false })
        .limit(1);
      before = (data?.[0] as Record<string, unknown> | undefined) ?? null;
    } else if (op === "module_update") {
      const { data } = await client
        .from("modules")
        .select("nav_label, icon, sort_order, parent_id")
        .eq("id", payload.module_id as string)
        .eq("project_id", projectId)
        .maybeSingle();
      before = (data as Record<string, unknown> | null) ?? null;
    } else if (op === "automation_delete") {
      const { data } = await client
        .from("automations")
        .select("module_id, name, definition")
        .eq("project_id", projectId)
        .eq("module_id", payload.module_id as string)
        .eq("name", payload.name as string)
        .maybeSingle();
      before = (data as Record<string, unknown> | null) ?? null;
    }

    const result = await write(op, payload);

    switch (op) {
      case "module_insert":
        undo.push({ kind: "op", op: "module_delete", payload: { module_id: result.id } });
        break;
      case "automation_insert":
        undo.push({
          kind: "op",
          op: "automation_delete",
          payload: { module_id: payload.module_id, name: payload.name },
        });
        break;
      case "schema_insert":
        // Put back by appending the old one again, the same way the
        // rollback route does. History stays a record of what happened
        // rather than being edited to hide it.
        //
        // With no earlier version there is nothing to restore, and the
        // section it belongs to is being removed anyway.
        if (before) {
          undo.push({
            kind: "op",
            op: "schema_insert",
            payload: {
              module_id: payload.module_id,
              schema_json: before.schema_json,
              version: Number(payload.version ?? 0) + 1,
              created_by: "ai",
              change_description: "Undone: a later part of the same build failed.",
            },
          });
        }
        break;
      case "module_update":
        if (before) {
          undo.push({
            kind: "op",
            op: "module_update",
            payload: { module_id: payload.module_id, ...before },
          });
        }
        break;
      case "automation_delete":
        if (before) {
          undo.push({
            kind: "op",
            op: "automation_insert",
            payload: { module_id: before.module_id, name: before.name, definition: before.definition },
          });
        }
        break;
      case "records_insert":
        undo.push({
          kind: "stranded",
          what: `${result.count ?? "some"} row(s) added to a section that already existed`,
        });
        break;
      case "automation_disable":
        undo.push({ kind: "stranded", what: `the rule "${String(payload.name)}" was switched off` });
        break;
      // request_claim, request_release and request_built are
      // bookkeeping about the request itself, not about the app.
      default:
        break;
    }
    return result;
  };
}

/** Replays the undo backwards. Returns what could not be put back. */
async function rollback(write: Write, undo: Undo[]): Promise<string[]> {
  const stranded: string[] = [];
  for (let i = undo.length - 1; i >= 0; i--) {
    const step = undo[i];
    if (step.kind === "stranded") {
      stranded.push(step.what);
      continue;
    }
    try {
      await write(step.op, step.payload);
    } catch (e) {
      // An undo that fails is worse than one that was never possible,
      // because the owner has no way to know. Say exactly which.
      stranded.push(`${step.op} could not be undone (${e instanceof Error ? e.message : "refused"})`);
    }
  }
  return stranded;
}

/**
 * Runs plans in order — a later plan may point at a section an earlier
 * one created — and, if one fails, puts the earlier ones back.
 *
 * It used to stop at the first failure and leave everything before it
 * standing. A two-plan design whose rule was refused left the merchant
 * a section with no rule in it, described on their screen as the thing
 * they had approved. Either the whole design is there or none of it is.
 */
export async function applyPlans(
  client: Db,
  projectId: string,
  plans: AssistantPlan[],
  /** The approved request this build is spending, when a client asked. */
  requestId: string | null = null
): Promise<ApplyOutcome> {
  const write = writer(client, projectId, requestId);
  const undo: Undo[] = [];
  const recorded = recording(client, projectId, write, undo);
  const applied: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  for (const rawPlan of plans.slice(0, 6)) {
    let result: ApplyResult;
    try {
      result = await validateAndApply(client, projectId, rawPlan, recorded);
    } catch (e) {
      result = { ok: false, errors: [e instanceof Error ? e.message : "Write refused."] };
    }
    if (result.ok) {
      applied.push(result.applied!);
      continue;
    }

    errors.push(...result.errors);
    if (applied.length > 0) {
      const stranded = await rollback(write, undo);
      errors.push(
        stranded.length === 0
          ? `Nothing was built: ${applied.length} earlier part(s) of this design were put back, so the app is as it was.`
          : `Nothing was built. ${applied.length} earlier part(s) were put back, except: ${stranded.join("; ")}.`
      );
      // Not one of them stands, so none of them is reported as applied.
      // Both callers read this to decide whether the request was built.
      applied.length = 0;
    }
    break;
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
    // A rule of the same name on the same section is that rule with a
    // new definition. It is updated in place, so its id never moves
    // and automation_runs keeps every time it fired — the history used
    // to be deleted along with the old row, which emptied the Rules
    // screen at the exact moment the merchant had changed something
    // and wanted to see what it had been doing.
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
