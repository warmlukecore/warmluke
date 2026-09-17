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
  | { kind: "rule"; automationName: string; what: string };

/**
 * Which parts of a build can be put back, from what it recorded.
 *
 * Not all of them, and the ones left out are left out honestly:
 *
 * - a new section is not here. Taking one back means deleting it and
 *   every row in it, and that is the one thing the app makes the owner
 *   type a name to confirm. The card already offers to delete it.
 * - rows seeded into an existing section are not here. Only a count
 *   was recorded, not which rows, and guessing would delete the
 *   merchant's own.
 * - a renamed or moved section is not here. The old label was never
 *   written down.
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
      automationName?: string;
      navLabel?: string;
    };
    if (typeof e.moduleId === "string" && typeof e.version === "number" && e.version > 1) {
      out.push({
        kind: "schema",
        moduleId: e.moduleId,
        version: e.version,
        what: e.changeType === "FIELD_ADD" ? "the fields it added" : "the layout it changed",
      });
    } else if (e.changeType === "AUTOMATION_ADD" && typeof e.automationName === "string") {
      out.push({
        kind: "rule",
        automationName: e.automationName,
        what: `the rule "${e.automationName}"`,
      });
    }
  }
  return out;
}
