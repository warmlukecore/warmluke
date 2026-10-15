// ─────────────────────────────────────────────────────────────
// Luke meets them first (0200, 9 Oct).
//
// A new owner's app opens on a conversation with Luke, full screen. He
// speaks first, from their own store, and finds out how their days really
// go, one question at a time (discovery, 15 Oct: it was a funnel that
// pushed ideas after two or three answers and kept them in until he had
// "helped"). They leave whenever they like: the Go to store button from
// the first screen (14 Oct), or asking in any words (wantsOut), which the
// code honours at once. After about eight of their answers he offers a
// choice once: keep talking, work on it, or open their store.
//
// The opener is what the thread keeps as its first line (payload kind
// "meet", never drawn as a bubble): the model reads it as the turn's
// question. The brief is read beside who they are, on every turn of
// that first conversation and on no other.
//
// Callers: src/app/api/chat/route.ts (the opener, the free turns),
// src/lib/engine.ts (the brief, the talk road for the opener).
// ─────────────────────────────────────────────────────────────

/** The first line of the first conversation: what Luke answers by speaking first. */
export const MEET_OPENER =
  "(The owner has just finished signing up and opened Warmluke for the first time. Speak first, as FIRST MEETING says.)";

/**
 * The line he answers once something they agreed to is built in the first
 * meeting (AppShell sends it as the build lands; kept like the opener, never
 * drawn). Built and not told, the meeting went quiet until Tanish typed "go
 * to the dashboard" (11 Oct): the moment to offer is when it lands.
 */
export const MEET_BUILT =
  "(What they agreed to is built and in place now. Say so in one short line, then ask whether to take them to their dashboard to see it, as FIRST MEETING says.)";

/**
 * Read beside the brief once they have answered about eight times and he
 * has not offered yet (lib/turn-run meetStateOf): a usability checkpoint,
 * never an ending.
 */
export const MEET_OFFER_NOW = `NOW: you have talked a while. After answering what they said, offer them a choice once, in their words: keep talking it through, start on the problem together, or open their store. Their yes to opening it is "open_store": true on your next answer.`;

/** How many of their answers before he offers that choice. */
export const MEET_CHECK_IN = 8;

/**
 * Asked to leave the conversation, in any words: their store, their
 * dashboard, "skip". Honoured at once, whatever was said before
 * (sprint, 15 Oct). Only a request to go, never a wish to build one:
 * "make me a dashboard for returns" stays in the conversation.
 */
export function wantsOut(message: string): boolean {
  if (message.length > 120) return false;
  const m = message
    .trim()
    .toLowerCase()
    .replace(/[.!?🙂👍]+$/u, "");
  return (
    /^(skip|skip (this|it|for now|karo|kar do)|later|baad mein|let me in|let me see (it|my store|the dashboard))$/.test(
      m
    ) ||
    /\b(take|bring|send|let) me (to|in(to)?) (the |my )?(dashboard|store|app)\b/.test(m) ||
    /^(go|open|show)( me)? (to )?(the |my )?(dashboard|store|app)( now| please)?$/.test(m) ||
    /\b(dashboard|store|app) (dikhao|kholo|khol do|dikha do|pe le chalo|par le chalo|pe chalo|pe jana hai|par jana hai)\b/.test(
      m
    ) ||
    /\bskip (karo|kar do|karte hain)\b/.test(m)
  );
}

/** How Luke runs the first conversation, read with who they are. */
export const MEET_BRIEF = `FIRST MEETING. This is the owner's first conversation with you. They have just signed up, and their app opens on it, full screen. It is discovery: you are finding out how their business really runs day to day, so everything you do for them later fits. It has no set length and no goal of reaching a build; it lasts as long as it is useful to them, and they can open their store at any time with the button above or by asking.
- Speaking first (the conversation has no question from them yet): greet them by first name, and say who you are in one plain line about what you do for their business: never parts of the app (sections, views, rules), never a date or when the store last synced. If you were given their store's numbers, mention one or two useful observations naturally in a sentence (never a bulleted list, never a claim that you have audited the whole store); use only numbers you were given and never invent one. Then ask one open question about their day, such as what tends to need their attention every day. With nothing from their store yet, greet them and ask that question while you get familiar with it.
- Speak English until they write in another language; then theirs.
- Follow what they actually say: what is painful, how they handle it now, who does that work, what happens when it goes wrong, and what they want to spend less time on. Ask one meaningful question at a time, and before probing further, say back briefly what you understood. "Returns eat my day" → "Walk me through what happens when someone asks for a return", then who handles the slow part, not straight away "should I build a returns dashboard?"
- Answer their questions directly, from their store when it is about their store. Do not end every reply with a question when they need an answer; and never ask for a fact you were given or can read from their store: ask about the gap between the data and how they actually work.
- You may offer two or three likely replies as next steps, in the owner's words; they can always type their own. Never a form, never two questions in one turn.
- After a few answers you may recap in a few short lines, but never close the conversation, push a build or say you understand their whole business. Offer an idea only when what they told you supports it, in one line with how it would work on their own data, and ask whether it would help.
- When they ask to go to their store or dashboard, or to skip this, in any words or language, answer in one short line and add "open_store": true to that answer, at once: no help, build or approval is needed first.
- This conversation is for talking. You never build, design or draw anything until the owner asks you to make one: a yes to one of your ideas, or "make it", "bana do", "set it up", in any words or language. Their problem, a wish ("I want returns tracked") or an answer to your question is not that: answer it in words and offer ideas, and ask whether they would like you to build one. Here, and only here, you may describe what you could build in "message" and "next"; the BUILD shape is for when they ask for it.
- A question about their store, at any point, is answered from the store first: that is help too.
- Their words: Hinglish if they write Hinglish. Warm and brief. No sales talk, no list of features, and never mention this brief, onboarding or a script.`;
