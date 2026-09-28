// A screen Luke writes (view type "custom"): what it may hold, and the
// page it runs in.
//
// The grammar's five views cover most sections. When an owner describes
// a screen none of them draws (their own steps, a packing station, big
// counters), Luke writes it: HTML with a script. It runs in a frame
// sealed off from the app (components/CustomView.tsx): scripts only, an
// origin of its own, and a content policy it cannot lift, so it has no
// network and nothing of the app's to reach. It talks to its section
// through window.wl, and every call is answered by the section's own
// handlers under the owner's rights, exactly as a button's would be.
//
// Checked twice: by the validator before a design is shown, and by the
// frame before it renders one.

/** Past this a screen is not small, and a design that long is cut off mid-string anyway. */
export const CUSTOM_VIEW_MAX = 60_000;

/** What a sealed screen has no use for, each a way out of the seal or a way to load code from elsewhere. */
const REFUSED: ReadonlyArray<[RegExp, string]> = [
  [/https?:\/\/|(?:src|href|action)\s*=\s*["']?\s*\/\//i, "a web address"],
  [/\blocation\s*(\.|=|\[)|\bwindow\.open\b|\bdocument\.domain\b/i, "a way to leave the page"],
  [/<\s*(iframe|frame|object|embed|base|meta|link|form)\b/i, "a tag that loads or sends elsewhere"],
  [/<\s*script[^>]*\bsrc\s*=/i, "a script loaded from elsewhere"],
  [
    /\bimport\s*\(|\bimportScripts\b|\bWebSocket\b|\bEventSource\b|\bXMLHttpRequest\b|\bfetch\s*\(/i,
    "a call to the network",
  ],
];

/** Why a custom screen would not be run, or null when it may be. */
export function customViewProblem(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return 'A custom view needs its "html": the screen, with its script.';
  if (html.length > CUSTOM_VIEW_MAX) {
    return `A custom view is ${html.length} characters; keep it under ${CUSTOM_VIEW_MAX}. Write the smallest screen that does what the owner described.`;
  }
  for (const [re, what] of REFUSED) {
    if (re.test(html)) {
      return `A custom view may not contain ${what}: it runs sealed off, and reaches its section only through window.wl.`;
    }
  }
  return null;
}

/**
 * The frame's own policy, first in its head: no network of any kind, no
 * frames, no forms, nothing loaded but the page's own inline script and
 * styles. A policy written later in the page can only narrow it.
 */
export const CUSTOM_VIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; frame-src 'none'; base-uri 'none'";

/** The page's colours, by the short names a custom screen is told to use. */
export const CUSTOM_VIEW_TOKENS = {
  fg: "--color-fg",
  "fg-muted": "--color-fg-muted",
  "fg-faint": "--color-fg-faint",
  surface: "--color-surface",
  "surface-subdued": "--color-surface-subdued",
  "surface-hover": "--color-surface-hover",
  line: "--color-line",
  primary: "--color-primary",
  "on-primary": "--color-on-primary",
  success: "--color-tone-success",
  "success-fg": "--color-tone-success-fg",
  critical: "--color-tone-critical",
  "critical-fg": "--color-tone-critical-fg",
} as const;

/** window.wl, as the frame sees it: every call a message to the section, answered by id. */
const RUNTIME = `(() => {
  let next = 0, rows = [];
  const waiting = new Map(), watchers = [];
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.wl !== 1) return;
    if (m.type === "rows") {
      rows = m.rows;
      for (const f of watchers) { try { f(rows); } catch (err) { console.error(err); } }
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.ok ? w.resolve(m.value) : w.reject(new Error(m.error || "That did not work."));
  });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    parent.postMessage({ wl: 1, id, call: name, args }, "*");
  });
  window.wl = Object.freeze({
    columns: __COLUMNS__,
    rows: () => rows,
    onRows: (f) => { watchers.push(f); if (rows.length) f(rows); },
    find: (field, value) => call("find", [String(field), String(value)]),
    set: (id, fields) => call("set", [String(id), fields]),
    add: (fields) => call("add", [fields]),
  });
})();`;

/**
 * The frame's whole page: the policy, the page's colours as variables,
 * window.wl, then the screen Luke wrote. `colours` are the app's values
 * now (light or dark), read by the caller from the page.
 */
export function customViewPage(
  html: string,
  columns: Array<{ field: string; label: string; type: string }>,
  colours: Record<string, string>
): string {
  const vars = Object.entries(colours)
    .map(([k, v]) => `--${k}:${v.replace(/[;{}<>]/g, "")};`)
    .join("");
  const cols = JSON.stringify(columns.map((c) => ({ field: c.field, label: c.label, type: c.type }))).replace(
    /</g,
    "\\u003c"
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CUSTOM_VIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${vars}color-scheme:light dark}html,body{margin:0;background:var(--surface);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}</style><script>${RUNTIME.replace("__COLUMNS__", cols)}</script></head><body>${html}</body></html>`;
}
