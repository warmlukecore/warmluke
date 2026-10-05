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
  /\b(add|build|make|create|remove|delete|drop|rename|change|update|edit|set ?up|turn (on|off)|enable|disable|move|reorder|automate|automation|rule|section|field|column|filter|button|dashboard|view|board|calendar|track(ing|er)?|scan(ner|ning)?|design|alert|notify|remind(er)?|banao|bana ?do|bnao|jodo|jod ?do|hatao|hata ?do|badlo|badal ?do|laga ?do|lagao|set ?kar|kar ?do)\b/i;
/**
 * A question, in either language, as people type it: "hows" and "whats"
 * with no apostrophe too. "hows my store doing" read as no question went
 * down the design road, planner and all, for a summary (2 Oct, $0.25).
 */
const QUESTION =
  /^((who|what|how|when|where|why|which)('?s|z)?|whose|is|are|was|were|do|does|did|can|could|will|would|should|kya|kaun|kaunsa|kaise|kaisa|kaisi|kab|kahan|kitna|kitne|kitni|kyu|kyun|kyon)\b/i;
/** Asked for what is so, not for a change: "give me last week's P&L", "batao kitni sale hui". Never "tell me when…", which is an alert. */
const INFO =
  /^(tell me|show me|give me|share|summari[sz]e|batao|bata ?do|dikhao|dikha ?do)\b(?!\s+(when|whenever|if|jab)\b)/i;
/** A Hinglish question asked mid-sentence: "store kaisa chal raha hai". */
const MID_QUESTION = /\b(kaisa|kaisi|kaise|kitna|kitni|kitne|kyun|kyu|kab|kahan|kaun)\b/i;
/** A request dressed as a question or a wish: "can you add…", "what if I could scan…", "would it be possible to track…". */
const ASKED_TO_BUILD =
  /^(can|could|will|would|please|pls|plz|what if|how about|is it possible|would it be possible|i want|i need|i wish|mujhe|kya (hum|main|aap|ye|yeh|isme|ismein))\b[^.?!]{0,60}\b(add|build|make|create|remove|delete|rename|change|design|track|scan|automate|banao|bana ?do|jodo|hatao|badlo|lagao|chahiye|ho sakta|kar sakte)\b/i;
const GREETING =
  /^(hi+|hello|hey+|yo|namaste|namaskar|thanks?|thank you|thx|ok(ay)?|good (morning|evening|afternoon|night)|bye|hola|sup)\b/i;
/**
 * With a section open, asking to see its rows a certain way, or giving a
 * row to put in (lib/screen.ts): "sirf COD wale dikhao", "filter by
 * Pending", "Asha ka return add karo #1042", or a customer's message
 * pasted on lines of its own. Luke does it on the screen, so it is talk.
 */
const ON_SCREEN =
  /\b(show|only|just|sirf|bas|see|dekh\w*|dikha\w*|filter|sort|newest|oldest|latest|recent|first|pehle|naye|purane|search|find|dhoo?nd\w*|wale|wali|vale|add|daal\w*|dal ?do|jod ?do|jodo|entry|likh ?do|note ?kar|fill|bhar ?do)\b|\n/i;
/** The app's own parts: asking to add or change one of these is a design, whatever else it says. */
const APP_PART =
  /\b(sections?|fields?|columns?|buttons?|rules?|filters?|tabs?|views?|boards?|calendar|dashboards?|screens?|automat\w*|alerts?|remind\w*|notif\w*|scan\w*|track\w*|options?|forms?|workflow)\b/i;
const CHANGE_VERB =
  /\b(add|build|make|create|remove|delete|drop|rename|change|edit|set ?up|enable|disable|move|reorder|banao|bana ?do|bnao|jodo|jod ?do|hatao|hata ?do|badlo|badal ?do|laga ?do|lagao)\b/i;

export function roadFor(turn: {
  message: string;
  /** What Luke last said in this thread: a question waits on its answer, a design on its yes. */
  lastReplyType: LastReply;
  /** The question already read as one about a store list, by the router. */
  routed: boolean;
  /** A section is open: Luke can do what they ask on its screen. */
  open?: boolean;
}): Road {
  const m = turn.message.trim();
  // Answers to Luke's questions, and a yes or no to a design, belong
  // to the design that asked: the stepper sends "Question\n→ answer".
  if (turn.lastReplyType === "clarify" || turn.lastReplyType === "blueprint" || /\n→ /.test(m)) return "design";
  if (turn.routed) return "talk";
  // On the screen open, unless it also asks to add or change a part of
  // the app ("add a filter for COD"): the talk road hands a build back.
  if (turn.open && ON_SCREEN.test(m) && !(CHANGE_VERB.test(m) && APP_PART.test(m))) return "talk";
  const words = m.split(/\s+/).length;
  // "ok add the RTO field" starts like a greeting and is not one.
  if (GREETING.test(m) && words <= 6 && !BUILD.test(m)) return "talk";
  if (ASKED_TO_BUILD.test(m)) return "design";
  if (QUESTION.test(m) || /\?\s*$/.test(m)) return "talk";
  if (BUILD.test(m)) return "design";
  if (INFO.test(m) || MID_QUESTION.test(m)) return "talk";
  // A follow-up to an answer ("and last month?", "same for Delhi") asks
  // more of the same; one that asks for a change said a build word above.
  if (turn.lastReplyType === "answer") return "talk";
  return "design";
}

/** The owner asked what is so rather than for a change: a reply in prose is then the answer. */
export function isQuestion(message: string): boolean {
  const m = message.trim();
  return (
    !ASKED_TO_BUILD.test(m) &&
    !BUILD.test(m) &&
    (QUESTION.test(m) || /\?\s*$/.test(m) || INFO.test(m) || MID_QUESTION.test(m))
  );
}

/** What Luke last said, read off the raw reply a thread keeps. */
export function lastReplyTypeOf(history: Array<{ role: string; content: string }>): LastReply {
  const last = [...history].reverse().find((t) => t.role === "assistant")?.content ?? "";
  const m = /"type"\s*:\s*"(clarify|blueprint|plans|answer)"/.exec(last);
  return (m?.[1] as Exclude<LastReply, null> | undefined) ?? null;
}
