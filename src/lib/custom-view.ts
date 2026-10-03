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

import { STATUS_LABELS } from "@/lib/tone";

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
 * A written screen's script that would not even parse, as the browser
 * would read it; null when every script parses. Parsing, never running:
 * new Function compiles a body and calls nothing. A screen that cannot
 * parse is a blank screen, so it goes back to Luke with the browser's
 * own words instead of reaching the owner. Where compiling is not
 * allowed (a page whose policy forbids it) nothing can be said, and
 * nothing is refused.
 */
export function customViewScriptProblem(html: string): string | null {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      new Function(script);
    } catch (e) {
      if (e instanceof SyntaxError) {
        return `The screen's script would not run: ${e.message}. Fix the script; the screen would be blank as it is.`;
      }
      return null;
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

/** The app's values (colours, corners, depth), by the short names a custom screen is told to use. */
export const CUSTOM_VIEW_TOKENS = {
  fg: "--color-fg",
  "fg-muted": "--color-fg-muted",
  "fg-faint": "--color-fg-faint",
  surface: "--color-surface",
  "surface-subdued": "--color-surface-subdued",
  "surface-hover": "--color-surface-hover",
  line: "--color-line",
  "line-strong": "--color-line-strong",
  focus: "--color-focus",
  link: "--color-link",
  primary: "--color-primary",
  "primary-hover": "--color-primary-hover",
  "on-primary": "--color-on-primary",
  "critical-solid": "--color-critical",
  success: "--color-tone-success",
  "success-fg": "--color-tone-success-fg",
  critical: "--color-tone-critical",
  "critical-fg": "--color-tone-critical-fg",
  attention: "--color-tone-attention",
  "attention-fg": "--color-tone-attention-fg",
  info: "--color-tone-info",
  "info-fg": "--color-tone-info-fg",
  neutral: "--color-tone-neutral",
  "neutral-fg": "--color-tone-neutral-fg",
  "radius-card": "--radius-card",
  "radius-control": "--radius-control",
  "shadow-card": "--shadow-card",
  "shadow-control": "--shadow-control",
  "shadow-dialog": "--shadow-dialog",
} as const;

/**
 * The app's look, for a screen Luke writes: its two faces, its type, and
 * the handful of pieces a working screen is made of, drawn as the app
 * draws them (ui/controls.ts, the stat cards, the table's rows). A screen
 * builds from these and writes its own CSS for layout alone, so every
 * screen looks like the rest of the app, in light and dark. Plain
 * elements (a heading, an input, a button, a table) look right unstyled.
 */
export const CUSTOM_VIEW_KIT = `
:root{--font:"WL Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:"WL Display",var(--font)}
html,body{margin:0;background:var(--surface);color:var(--fg);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
h1,h2,h3,.wl-title,.wl-big,.wl-count{font-family:var(--font-display);margin:0;letter-spacing:-.01em}
h1{font-size:20px;font-weight:650;line-height:1.3}h2,.wl-title{font-size:16px;font-weight:600;line-height:1.35}h3{font-size:14px;font-weight:600}
p{margin:0}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
input,select,textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-control);padding:6px 10px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 15%,transparent)}
button,.wl-button{font:inherit;font-size:13px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:0;border-radius:var(--radius-control);background:var(--surface);color:var(--fg);box-shadow:var(--shadow-card);cursor:pointer;white-space:nowrap}
button:hover,.wl-button:hover{background:var(--surface-hover)}button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.wl-button.primary{background:var(--primary);color:var(--on-primary);box-shadow:var(--shadow-control)}.wl-button.primary:hover{background:var(--primary-hover)}
.wl-button.critical{background:var(--critical-solid);color:#fff;box-shadow:var(--shadow-control)}
.wl-button.big{height:48px;padding:0 20px;font-size:16px;font-weight:600}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;font-weight:500;color:var(--fg-muted);padding:8px 12px;border-bottom:1px solid var(--line)}td{padding:10px 12px;border-bottom:1px solid var(--line)}
.wl-page{max-width:960px;margin:0 auto;padding:16px;display:grid;gap:12px}
:not(.wl-stack,.wl-grid,.wl-inline,.wl-page,.wl-list)>:is(.wl-card,.wl-list,.wl-banner,.wl-inline,.wl-grid,.wl-scan)+:is(.wl-card,.wl-list,.wl-banner,.wl-inline,.wl-grid,.wl-scan){margin-top:12px}
.wl-stack{display:grid;gap:12px}.wl-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.wl-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.wl-card{background:var(--surface);border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:16px}
.wl-card.now{box-shadow:0 0 0 2px var(--primary)}.wl-card.bad{box-shadow:0 0 0 2px var(--critical-fg)}
.wl-label{font-size:12px;font-weight:500;color:var(--fg-muted)}
.wl-muted{color:var(--fg-muted)}.wl-faint{color:var(--fg-faint)}
.wl-big{font-size:clamp(16px,3.6vw,20px);font-weight:600;line-height:1.3}
.wl-count{font-size:24px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}.wl-count.big{font-size:clamp(32px,8vw,48px);line-height:1.05}
.wl-scan{width:100%;height:auto;font-size:clamp(17px,3.6vw,20px);padding:12px 14px;border-color:var(--line-strong);box-shadow:var(--shadow-control)}
.wl-banner{border-radius:var(--radius-card);padding:10px 14px;font-size:14px;font-weight:500;line-height:1.4;background:var(--surface-subdued);color:var(--fg)}.wl-banner.big{padding:12px 16px;font-size:clamp(15px,3.4vw,18px);font-weight:600}
.ok.wl-banner,.ok.wl-badge{background:var(--success);color:var(--success-fg)}.bad.wl-banner,.bad.wl-badge{background:var(--critical);color:var(--critical-fg)}
.warn.wl-banner,.warn.wl-badge{background:var(--attention);color:var(--attention-fg)}.info.wl-banner,.info.wl-badge{background:var(--info);color:var(--info-fg)}
.wl-list{background:var(--surface);border-radius:var(--radius-card);box-shadow:var(--shadow-card);overflow:hidden}
.wl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--line)}.wl-row:first-child{border-top:0}
.wl-row.done{color:var(--fg-muted)}.wl-row.bad{background:color-mix(in srgb,var(--critical) 45%,transparent)}
.wl-dialog{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--fg) 35%,transparent)}.wl-dialog>.wl-card{width:min(440px,100%);box-shadow:var(--shadow-dialog)}
.wl-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;background:var(--neutral);color:var(--neutral-fg)}
.wl-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.wl-form{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.wl-form>.wide{grid-column:1/-1}
.wl-field{display:grid;gap:4px;align-content:start;font-size:12px;font-weight:500;color:var(--fg-muted)}.wl-field>:is(input,select,textarea,.wl-select){width:100%;font-size:14px;font-weight:400}
textarea{min-height:72px;resize:vertical}
.wl-table{overflow-x:auto;margin:0 -4px}.wl-table table{min-width:100%}td{vertical-align:top}.wl-nowrap,td.num,td.date{white-space:nowrap}td.num{text-align:right;font-variant-numeric:tabular-nums}
.wl-empty{padding:20px 12px;text-align:center;color:var(--fg-muted);font-size:13px}
select,.wl-select{appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a8a8a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.wl-select{font:inherit;text-align:left;height:auto;min-height:35px;justify-content:flex-start;padding:6px 30px 6px 10px;border:1px solid var(--line);border-radius:var(--radius-control);background-color:var(--surface);box-shadow:none;color:var(--fg);overflow:hidden;text-overflow:ellipsis}
.wl-select:hover{background-color:var(--surface-hover)}.wl-select[aria-expanded=true]{border-color:var(--focus)}
.wl-menu{position:absolute;z-index:60;max-height:240px;overflow:auto;padding:4px;background:var(--surface);border-radius:var(--radius-control);box-shadow:var(--shadow-dialog)}
.wl-option{padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap}.wl-option:is(:hover,:focus){background:var(--surface-hover);outline:none}.wl-option[aria-selected=true]{font-weight:600}
body::after{content:"";display:block;height:80px}
@media (max-width:480px){.wl-page{padding:12px}.wl-card{padding:14px}}
`.replace(/\n/g, "");

/** window.wl, as the frame sees it: every call a message to the section, answered by id. */
const RUNTIME = `(() => {
  // A screen keeps focus where its scanner types, but never takes it back
  // from the page around it: a screen that refocused its input on blur
  // pulled focus out of Luke's panel, and the owner could not copy from
  // it. While the frame is not the one in use, the request waits, and is
  // kept the moment the owner comes back to the screen.
  const focusNow = HTMLElement.prototype.focus;
  let wanted = null;
  HTMLElement.prototype.focus = function (options) {
    if (document.hasFocus()) return focusNow.call(this, options);
    wanted = this;
  };
  addEventListener("focus", () => {
    const w = wanted;
    wanted = null;
    if (w && w.isConnected && document.activeElement !== w) focusNow.call(w);
  });
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
    // The app switched light or dark: the new values, in place, so the
    // screen keeps where its user was rather than reloading to take them.
    if (m.type === "colours") {
      const root = document.documentElement.style;
      for (const [k, v] of Object.entries(m.colours || {})) root.setProperty("--" + k, String(v));
      if (m.scheme === "dark" || m.scheme === "light") root.colorScheme = m.scheme;
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
  // The app's dialog, for a question: the frame may not open the
  // browser's own (alert, confirm and prompt do nothing in it). While it
  // is open a key from outside it is held, so a scanner's Enter never
  // answers it; Tab moves into it, and a button there, tapped or
  // pressed, does. Escape is "no".
  const ask = (question, yes, no) => new Promise((done) => {
    const back = document.createElement("div");
    back.className = "wl-dialog";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    const card = document.createElement("div");
    card.className = "wl-card wl-stack";
    const said = document.createElement("div");
    said.className = "wl-title";
    said.textContent = String(question);
    const row = document.createElement("div");
    row.className = "wl-inline";
    const buttons = [];
    const close = (value) => {
      removeEventListener("keydown", keys, true);
      back.remove();
      done(value);
    };
    const add = (text, value, primary) => {
      const b = document.createElement("button");
      b.className = "wl-button big" + (primary ? " primary" : "");
      b.textContent = text;
      b.onclick = () => close(value);
      row.append(b);
      buttons.push(b);
    };
    const keys = (e) => {
      if (back.contains(e.target)) {
        if (e.key === "Escape") close(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") close(false);
      else if (e.key === "Tab") buttons[0].focus();
    };
    add(yes == null ? "Yes" : String(yes), true, true);
    if (no !== null) add(no == null ? "No" : String(no), false, false);
    card.append(said, row);
    back.append(card);
    addEventListener("keydown", keys, true);
    document.body.append(back);
  });
  window.alert = (message) => { void ask(message, "OK", null); };
  // Money as the app writes it: its locale, and the currency named (a
  // store row's own) or else the project's. A screen that wrote "Rs 1424"
  // beside a table saying "₹1,424.00" read as two apps.
  const FORMAT = __FORMAT__;
  const moneyFormats = new Map();
  const money = (amount, currency) => {
    const n = Number(amount);
    if (amount === null || amount === undefined || amount === "" || Number.isNaN(n)) return "—";
    const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : FORMAT.currency;
    let f = moneyFormats.get(code);
    if (!f) {
      try {
        f = new Intl.NumberFormat(FORMAT.locale, { style: "currency", currency: code, maximumFractionDigits: 2 });
      } catch {
        f = new Intl.NumberFormat(FORMAT.locale, { style: "currency", currency: FORMAT.currency, maximumFractionDigits: 2 });
      }
      moneyFormats.set(code, f);
    }
    return f.format(n);
  };
  // A date and a status as the app writes them: "3 Oct 2026", "Payment
  // pending". A screen that printed 2026-10-02 and PENDING beside a table
  // saying otherwise read as two apps (Returns, 3 Oct).
  const LABELS = __LABELS__;
  const dayFormat = new Intl.DateTimeFormat(FORMAT.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const date = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const s = String(v);
    const d = /^\\d{4}-\\d{2}-\\d{2}$/.test(s) ? new Date(s + "T00:00:00Z") : new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return /^\\d{4}-\\d{2}-\\d{2}$/.test(s) ? dayFormat.format(d) : d.toLocaleDateString(FORMAT.locale, { day: "numeric", month: "short", year: "numeric" });
  };
  const label = (v) => (v === null || v === undefined || v === "" ? "—" : LABELS[String(v).trim()] || String(v));
  // A choice drawn as the app draws one, never the computer's own menu:
  // each <select> is shown as a button and a list, and the select stays,
  // hidden, holding the value, so a script reads and sets it as before.
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
  for (const [name, d] of [["value", nativeValue], ["selectedIndex", nativeIndex]])
    Object.defineProperty(HTMLSelectElement.prototype, name, {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { d.set.call(this, v); if (this._wlSync) this._wlSync(); },
    });
  let openMenu = null;
  const shut = () => { if (openMenu) { openMenu.close(); openMenu = null; } };
  addEventListener("mousedown", (e) => { if (openMenu && !openMenu.list.contains(e.target) && e.target !== openMenu.button) shut(); }, true);
  addEventListener("scroll", shut, true);
  // A click outside the frame never reaches it: the frame losing focus is that click.
  addEventListener("blur", shut);
  const upgrade = (sel) => {
    if (sel._wlSync || sel.multiple || sel.size > 1 || sel.dataset.native !== undefined) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wl-select";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    // Its name is the field's words (a label wrapping it names the hidden
    // select, not this), and then what is chosen.
    const wrap = sel.closest("label");
    const named = (
      sel.getAttribute("aria-label") ||
      (sel.id && document.querySelector('label[for="' + CSS.escape(sel.id) + '"]')?.textContent) ||
      (wrap ? [...wrap.childNodes].filter((n) => n !== sel && n !== button).map((n) => n.textContent).join(" ") : "") ||
      ""
    ).trim();
    sel._wlSync = () => {
      const o = sel.options[sel.selectedIndex];
      button.textContent = o ? o.text : "";
      button.disabled = sel.disabled;
      if (named) button.setAttribute("aria-label", named + ": " + (o ? o.text : ""));
    };
    sel._wlSync();
    sel.addEventListener("change", sel._wlSync);
    sel.style.display = "none";
    sel.after(button);
    const choose = (i) => {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      shut();
      button.focus();
    };
    const open = () => {
      shut();
      const list = document.createElement("div");
      list.className = "wl-menu";
      list.setAttribute("role", "listbox");
      const items = [...sel.options].map((o, i) => {
        const it = document.createElement("div");
        it.className = "wl-option";
        it.setAttribute("role", "option");
        it.tabIndex = -1;
        it.textContent = o.text;
        it.setAttribute("aria-selected", String(i === sel.selectedIndex));
        if (o.disabled) it.setAttribute("aria-disabled", "true");
        else it.onclick = () => choose(i);
        list.append(it);
        return it;
      });
      list.addEventListener("keydown", (e) => {
        const at = items.indexOf(document.activeElement);
        const go = (n) => { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, n))]?.focus(); };
        if (e.key === "ArrowDown") go(at + 1);
        else if (e.key === "ArrowUp") go(at - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(items.length - 1);
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (at >= 0 && !sel.options[at].disabled) choose(at); }
        else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); shut(); button.focus(); }
      });
      const r = button.getBoundingClientRect();
      list.style.minWidth = r.width + "px";
      list.style.left = r.left + scrollX + "px";
      document.body.append(list);
      // Below when it fits, else above: never cut off by the frame's foot.
      const below = r.bottom + list.offsetHeight + 8 <= innerHeight || r.top < list.offsetHeight + 8;
      list.style.top = (below ? r.bottom + 4 : r.top - list.offsetHeight - 4) + scrollY + "px";
      button.setAttribute("aria-expanded", "true");
      openMenu = { list, button, close: () => { list.remove(); button.setAttribute("aria-expanded", "false"); } };
      (items[sel.selectedIndex] || items[0])?.focus();
    };
    button.addEventListener("click", () => (openMenu?.button === button ? shut() : open()));
    button.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } });
  };
  const upgradeAll = () => document.querySelectorAll("select").forEach(upgrade);
  new MutationObserver(upgradeAll).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("DOMContentLoaded", upgradeAll);
  window.wl = Object.freeze({
    columns: __COLUMNS__,
    ask,
    rows: () => rows,
    onRows: (f) => { watchers.push(f); if (rows.length) f(rows); },
    find: (field, value, section) =>
      call("find", section === undefined ? [String(field), String(value)] : [String(field), String(value), String(section)]),
    read: (section) => call("read", [String(section)]),
    money,
    date,
    label,
    currency: FORMAT.currency,
    set: (id, fields) => call("set", [String(id), fields]),
    add: (fields) => call("add", [fields]),
  });
})();`;

/**
 * The frame's whole page: the policy, the app's faces and its values as
 * variables (light or dark, read by the caller from the page), the kit,
 * window.wl, then the screen Luke wrote. `fonts` is the app's own
 * @font-face rules with their files inline, which the policy allows; a
 * page without them falls back to the system's face.
 */
export function customViewPage(
  html: string,
  columns: Array<{ field: string; label: string; type: string }>,
  colours: Record<string, string>,
  fonts = "",
  /** The app's locale and the project's currency, for wl.money. */
  format: { locale: string; currency: string } = { locale: "en-IN", currency: "INR" },
  /**
   * The app's own choice, not the computer's: "light dark" drew the
   * frame's inputs and canvas by the computer's setting, so a dark app on
   * a light computer showed a light box inside it.
   */
  scheme: "light" | "dark" = "light"
): string {
  const vars = Object.entries(colours)
    .map(([k, v]) => `--${k}:${v.replace(/[;{}<>]/g, "")};`)
    .join("");
  const cols = JSON.stringify(columns.map((c) => ({ field: c.field, label: c.label, type: c.type }))).replace(
    /</g,
    "\\u003c"
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CUSTOM_VIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts.replace(/<\/?style/gi, "")}:root{${vars}color-scheme:${scheme === "dark" ? "dark" : "light"}}${CUSTOM_VIEW_KIT}</style><script>${RUNTIME.replace(
    "__COLUMNS__",
    () => cols
  )
    .replace("__FORMAT__", () =>
      JSON.stringify({ locale: String(format.locale), currency: String(format.currency) }).replace(/</g, "\\u003c")
    )
    .replace("__LABELS__", () =>
      JSON.stringify(STATUS_LABELS).replace(/</g, "\\u003c")
    )}</script></head><body>${html}</body></html>`;
}
