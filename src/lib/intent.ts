// Which road a turn takes.
//
// Every message used to go down one road: the whole design contract,
// eleven thousand tokens of grammar and rules, whether the owner asked
// for a packing workflow or said hello. On the talk road the model is
// told only how to answer; on the design road, everything. Decided in
// code, from the words and where the thread stands, never by a model:
// a wrong turn onto the design road costs tokens and nothing else, and
// a wrong turn onto the talk road is handed back by the model itself
// (a "build" reply), so the default when unsure is the design road.
//
// Callers: src/lib/engine.ts.

export type Road = "talk" | "design";

export type LastReply = "clarify" | "blueprint" | "plans" | "answer" | null;

/** Words that ask for the app to change: a section, a field, a rule, a screen. */
const BUILD =
  /\b(add|build|make|create|remove|delete|drop|rename|change|update|edit|set ?up|turn (on|off)|enable|disable|move|reorder|automate|automation|rule|section|field|column|filter|button|dashboard|view|board|calendar|track(ing|er)?|scan(ner|ning)?|design|banao|bana ?do|bnao|jodo|jod ?do|hatao|hata ?do|badlo|badal ?do|laga ?do|lagao|set ?kar|kar ?do)\b/i;
/** A question, in either language. */
const QUESTION =
  /^(who|whose|what|whats|what's|how|when|where|why|which|is|are|was|were|do|does|did|can|could|will|would|should|kya|kaun|kaunsa|kaise|kab|kahan|kitna|kitne|kitni|kyu|kyun|kyon)\b/i;
/** A request dressed as a question or a wish: "can you add…", "what if I could scan…", "would it be possible to track…". */
const ASKED_TO_BUILD =
  /^(can|could|will|would|please|pls|plz|what if|how about|is it possible|would it be possible|i want|i need|i wish|mujhe|kya (hum|main|aap|ye|yeh|isme|ismein))\b[^.?!]{0,60}\b(add|build|make|create|remove|delete|rename|change|design|track|scan|automate|banao|bana ?do|jodo|hatao|badlo|lagao|chahiye|ho sakta|kar sakte)\b/i;
const GREETING =
  /^(hi+|hello|hey+|yo|namaste|namaskar|thanks?|thank you|thx|ok(ay)?|good (morning|evening|afternoon|night)|bye|hola|sup)\b/i;

export function roadFor(turn: {
  message: string;
  /** What Luke last said in this thread: a question waits on its answer, a design on its yes. */
  lastReplyType: LastReply;
  /** The question already read as one about a store list, by the router. */
  routed: boolean;
}): Road {
  const m = turn.message.trim();
  // Answers to Luke's questions, and a yes or no to a design, belong
  // to the design that asked: the stepper sends "Question\n→ answer".
  if (turn.lastReplyType === "clarify" || turn.lastReplyType === "blueprint" || /\n→ /.test(m)) return "design";
  if (turn.routed) return "talk";
  const words = m.split(/\s+/).length;
  if (GREETING.test(m) && words <= 6) return "talk";
  if (ASKED_TO_BUILD.test(m)) return "design";
  if (QUESTION.test(m) || /\?\s*$/.test(m)) return "talk";
  if (BUILD.test(m)) return "design";
  return "design";
}

/** What Luke last said, read off the raw reply a thread keeps. */
export function lastReplyTypeOf(history: Array<{ role: string; content: string }>): LastReply {
  const last = [...history].reverse().find((t) => t.role === "assistant")?.content ?? "";
  const m = /"type"\s*:\s*"(clarify|blueprint|plans|answer)"/.exec(last);
  return (m?.[1] as Exclude<LastReply, null> | undefined) ?? null;
}
