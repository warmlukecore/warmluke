// What an error is, when a person has to read it.
//
// Every error in the app was a string. A string can say what went
// wrong; it cannot say what to do about it, because by the time it is
// a string the context that would have said so is gone — the rows
// that nearly matched, the values that were allowed, the plan that
// did not fit. So the merchant read "No row with sku_barcode 12345"
// and had nowhere to go from there but a guess.
//
// This is the shape instead. The part that knows — the place the error
// happens — fills in `fix`; one renderer shows any of them the same
// way; one dispatcher runs the actions. New errors join by taking the
// shape. Old strings still render: asError() lifts them.
//
// `kind` is who can fix it, which is the only thing that matters:
//
//   data    the merchant's own input or rows. They fix it, with the
//           nearest match handed to them. No model: it knows nothing
//           the code does not, and a guess about inventory is worse
//           than no guess.
//   engine  a design, rule or import that did not fit. Luke fixes it,
//           by proposing a correction that goes through approval like
//           any other change — never applied on its own.
//   system  the network, a quota, a server. Nobody fixes it from a
//           button; say so plainly and offer to try again.

export type FixAction =
  /** Try again with this value — the scan bar, with a near match. */
  | { type: "use_value"; value: string }
  /** Make a row with this data in the section on screen. */
  | { type: "add_row"; data: Record<string, unknown> }
  /**
   * Hand it to Luke. The prompt is written where the error happened,
   * because that is where the plan, the rule and the reason are; Luke
   * answers with a corrected design, which waits for a yes.
   */
  | { type: "ask_luke"; prompt: string }
  | { type: "retry" };

export type Fix = {
  label: string;
  action: FixAction;
  /**
   * Shown as a plain link, never as the bright button. For a way out
   * that is sometimes right and often not — making a row for a code
   * nobody recognised, in a packing list — the button was an
   * invitation, and a packer's thumb would have taken it.
   */
  quiet?: boolean;
};

export type AppError = {
  kind: "data" | "engine" | "system";
  /** One line, in the merchant's words. */
  what: string;
  /** The reason, when it is known. */
  why?: string;
  /** The raw lines underneath — validator output, a server message. */
  details?: string[];
  /** Ways out, best first. */
  fix?: Fix[];
};

/** Anything thrown or returned, as an AppError. Strings stay strings. */
export function asError(e: unknown, fallback = "That didn't work."): AppError {
  if (e && typeof e === "object" && "kind" in e && "what" in e) return e as AppError;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : fallback;
  return { kind: "system", what: message || fallback };
}

/** A design or rule that did not fit, with Luke on the end of it. */
export function engineError(what: string, details: string[], prompt: string, why?: string): AppError {
  return {
    kind: "engine",
    what,
    ...(why ? { why } : {}),
    details: details.slice(0, 6),
    fix: [{ label: "Ask Luke to fix it", action: { type: "ask_luke", prompt } }],
  };
}

// ── Near matches ──────────────────────────────────────────────────
//
// A scanner that dropped a leading zero, a finger that hit 4 for 5:
// the row is there, one character away. Edit distance finds it; the
// threshold is strict enough that "12345" does not suggest "98765".

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Optimal string alignment: two adjacent characters swapped — 12354
  // for 12345, the commonest typo there is — count as one edit, not
  // two. Plain Levenshtein put the right row out of reach.
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

export type Near<T> = { value: string; item: T; distance: number };

/**
 * The candidates closest to `value`, closest first, at most `max`.
 *
 * Only ones close enough to be the same thing mistyped: within one
 * edit for short codes, a quarter of the length for long ones, and
 * never a different thing altogether. Case and surrounding space are
 * not differences.
 */
export function nearest<T>(value: string, candidates: Array<{ value: string; item: T }>, max = 3): Near<T>[] {
  const v = value.trim().toLowerCase();
  if (!v) return [];
  const allowed = Math.max(1, Math.floor(v.length / 4));
  const seen = new Set<string>();
  const out: Near<T>[] = [];
  for (const c of candidates) {
    const cv = c.value.trim().toLowerCase();
    if (!cv || seen.has(cv) || cv === v) continue;
    seen.add(cv);
    // A contained code — "2345" inside "12345" — is a dropped
    // character, and worth showing even when the lengths differ.
    const d = cv.includes(v) || v.includes(cv) ? Math.abs(cv.length - v.length) : distance(v, cv);
    if (d <= allowed) out.push({ value: c.value, item: c.item, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value)).slice(0, max);
}

// ── What Luke is told ─────────────────────────────────────────────

/**
 * The prompt an engine error carries, written once so every "Ask Luke
 * to fix it" reads the same to Luke: what was tried, why it did not
 * fit, and the one instruction that matters — the same job, corrected.
 */
export function fixPrompt(opts: { what: string; tried?: unknown; errors: string[]; ask?: string }): string {
  const tried = opts.tried === undefined ? "" : JSON.stringify(opts.tried, null, 1);
  const shown = tried.length > 4000 ? `${tried.slice(0, 4000)}\n…` : tried;
  return [
    `This did not go in: ${opts.what}`,
    shown ? `What was tried:\n${shown}` : "",
    opts.errors.length ? `Why it did not fit:\n${opts.errors.map((e) => `- ${e}`).join("\n")}` : "",
    opts.ask ??
      "Look at the project's current sections and give me a corrected design that does the same job. Change only what has to change.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
