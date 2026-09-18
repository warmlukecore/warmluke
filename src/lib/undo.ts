// Putting a build back.
//
// Split out of lib/apply so the panel can read it too: apply.ts talks
// to the database, and the browser only needs to know what a build
// offered to undo and how to say it.

/**
 * A change that can be taken back, named so a person can read it.
 *
 * Kept on the message rather than worked out later: by the time the
 * merchant taps this the section may have moved on, and what we want
 * to restore is what it was before THIS build, not before whatever
 * happened since.
 */
export type UndoStep =
  | { kind: "schema"; moduleId: string; version: number; what: string }
  /** Rows a build seeded. Only the ones nobody has edited since go. */
  | { kind: "rows"; moduleId: string; recordIds: string[]; what: string }
  /**
   * A section renamed or moved. `was` is what it said before; `set`
   * is what this build made it say, so an undo can tell whether it
   * has been changed again since.
   */
  | {
      kind: "module";
      moduleId: string;
      was: Record<string, unknown>;
      set: Record<string, unknown>;
      what: string;
    }
  | {
      kind: "rule";
      /** The row the build wrote, so undoing it touches only that one. */
      automationId: string;
      /** Its definition and enabled state before, when it existed. */
      was: { definition?: unknown; enabled?: boolean } | null;
      what: string;
    };

/**
 * Which parts of a build can be put back, from what it recorded.
 *
 * Not all of them, and the ones left out are left out honestly:
 *
 * - a new section is not here. Taking one back means deleting it and
 *   every row in it, and that is the one thing the app makes the owner
 *   type a name to confirm. The card already offers to delete it.
 * - rows seeded into a section are here, by id, and only the ones
 *   nobody has edited since: a seeded row somebody has since typed
 *   into is their row now.
 * - a renamed or moved section is here, with what it said before.
 *
 * A schema change is: every version is kept, so the one before is
 * still sitting there.
 */
export function undoableFrom(applied: unknown[]): UndoStep[] {
  const out: UndoStep[] = [];
  for (const a of applied) {
    const e = a as {
      changeType?: string;
      moduleId?: string;
      version?: number;
      automationId?: string;
      automationName?: string;
      automationWas?: { definition?: unknown; enabled?: boolean } | null;
      navLabel?: string;
      recordIds?: string[];
      was?: Record<string, unknown> | null;
      set?: Record<string, unknown> | null;
    };
    if (typeof e.moduleId === "string" && typeof e.version === "number" && e.version > 1) {
      out.push({
        kind: "schema",
        moduleId: e.moduleId,
        version: e.version,
        what: e.changeType === "FIELD_ADD" ? "the fields it added" : "the layout it changed",
      });
    } else if (e.changeType === "RECORD_SEED" && typeof e.moduleId === "string" && Array.isArray(e.recordIds) && e.recordIds.length) {
      out.push({
        kind: "rows",
        moduleId: e.moduleId,
        recordIds: e.recordIds,
        what: `the ${e.recordIds.length} row${e.recordIds.length === 1 ? "" : "s"} it added`,
      });
    } else if (e.changeType === "MODULE_UPDATE" && typeof e.moduleId === "string" && e.was && e.set) {
      out.push({
        kind: "module",
        moduleId: e.moduleId,
        was: e.was,
        set: e.set,
        what: "the section's name and place",
      });
    } else if (e.changeType === "AUTOMATION_ADD" && typeof e.automationId === "string") {
      out.push({
        kind: "rule",
        automationId: e.automationId,
        was: e.automationWas ?? null,
        // A rule that was rewritten goes back to what it said before;
        // one that was made goes off. Different words, because they
        // are different outcomes and the merchant is choosing between
        // them by reading this line.
        what: e.automationWas
          ? `the rule "${e.automationName ?? "it changed"}" to what it said before`
          : `the rule "${e.automationName ?? "it added"}"`,
      });
    }
  }
  return out;
}
