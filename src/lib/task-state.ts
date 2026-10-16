// ─────────────────────────────────────────────────────────────
// Where a task with Luke stands, in the words the owner reads (16 Oct):
// working, needs your answer, needs your yes, a check failed, did not
// finish, stopped, or done. Worked out from the thread's last line as it
// is kept (messages.payload), so every list says the same thing, and a
// thread never sits on an unexplained spinner or claims success without
// its receipt.
//
// Callers: src/app/api/chat/route.ts (each thread's state),
// src/components/ChatPanel.tsx (the past conversations), scripts/check-task-state.mjs.
// ─────────────────────────────────────────────────────────────

export type TaskState = "working" | "needs_answer" | "needs_yes" | "check_failed" | "failed" | "stopped" | "done";

export const TASK_LABEL: Record<TaskState, string> = {
  working: "Working",
  needs_answer: "Needs your answer",
  needs_yes: "Needs your yes",
  check_failed: "A check failed",
  failed: "Didn't finish",
  stopped: "Stopped",
  done: "Done",
};

/** A thread's last line as kept: who wrote it, its type, a build's status, an answer's kind, a build's test. */
export type LastLine = {
  role: string;
  ptype: string | null;
  pstatus?: string | null;
  pkind?: string | null;
  /** The after-build test (lib/verify `tested.ok`), as the database hands it back: "true", "false" or null. */
  ptested?: string | boolean | null;
};

/** Where the task stands, or null when its last line says nothing about it (an owner's words with no answer line yet). */
export function taskStateOf(last: LastLine | null | undefined): TaskState | null {
  if (!last || last.role !== "assistant") return null;
  switch (last.ptype) {
    case "answering":
      return "working";
    case "clarify":
      return "needs_answer";
    case "blueprint":
    case "plans":
      return "needs_yes";
    case "build":
      if (last.pstatus === "building") return "working";
      if (last.pstatus === "refused") return "failed";
      return String(last.ptested) === "false" ? "check_failed" : "done";
    case "applied":
      return "done";
    case "unanswered":
      return "failed";
    case "stopped":
      return "stopped";
    case "answer":
      // A plan said in words, waiting for "Build it" (lib/plan proposals).
      return last.pkind === "proposal" ? "needs_yes" : "done";
    default:
      return null;
  }
}
