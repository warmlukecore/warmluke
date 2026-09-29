// What a proposal's preview in Luke's panel draws: only what the change
// makes different, laid over the section as it is, so the card says at a
// glance what Build would do. The whole open section redrawn beside the
// chat showed what was already behind it, followed every edit made
// there, and on another section drew that one's columns under the change.

import type { AssistantPlan, FeatureSchema, UiSchema } from "@/lib/types";

/** Rows a preview's list shows: enough to read a column by, not a page. */
export const PREVIEW_ROWS = 3;

/**
 * The schema a preview draws, given the section the change is for as it
 * is now (null for a new one). Null when the change draws nothing: a
 * rename, a rule, a part only removed.
 */
export function changeShown(plan: AssistantPlan, section: UiSchema | null): UiSchema | null {
  switch (plan.changeType) {
    case "NEW_MODULE":
      // With its parts: a new section's written screen or stats are the point of it.
      return plan.newSchema?.columns?.length
        ? { columns: plan.newSchema.columns, features: plan.features ?? null }
        : null;
    case "FIELD_ADD": {
      const had = section?.columns ?? [];
      const added = (plan.newSchema?.columns ?? []).filter((c) => !had.some((h) => h.field === c.field));
      if (added.length === 0) return null;
      // Beside the section's first column, so each row still reads as whose.
      return { columns: had.length ? [had[0], ...added] : added };
    }
    case "UI_CHANGE":
      return plan.newSchema?.columns?.length ? { columns: plan.newSchema.columns } : null;
    case "FEATURE_UPDATE": {
      const named = Object.fromEntries(
        Object.entries(plan.features ?? {}).filter(([, v]) => v !== null && v !== undefined)
      ) as FeatureSchema;
      if (Object.keys(named).length === 0) return null;
      // A written screen is the change whole: the section's other parts are not drawn around it.
      return {
        columns: section?.columns ?? [],
        features: named.view?.type === "custom" ? { view: named.view } : named,
      };
    }
    default:
      return null;
  }
}
