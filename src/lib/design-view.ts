// A design's preview inside the merchant's own AI (MCP Apps, 2026-01-26).
//
// Through Claude or ChatGPT a design came back as words, read out, and
// the merchant said yes to a screen they had never seen. Hosts that
// speak MCP Apps now draw a page a server hands them beside the tool's
// answer: this is that page. The design tools name it (_meta.ui); the
// server lists and reads it (resources/*); each design's answer carries
// what it draws (structuredContent.design): every part's fields and a
// few of its rows, and a written screen run read-only over them.
//
// The page loads nothing: its script and styles are inline, the host's
// sandbox allows no more, and a screen in it saves nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { changeShown } from "@/lib/change-preview";
import { CUSTOM_VIEW_KIT } from "@/lib/custom-view";
import { describeForOwner } from "@/lib/describe";
import { isStoreTable, readStoreRows, storeSectionColumns, withOwnFields } from "@/lib/store-read";
import type { AssistantPlan, ModuleRow, UiSchema } from "@/lib/types";

export const DESIGN_VIEW_URI = "ui://warmluke/design";
export const DESIGN_VIEW_MIME = "text/html;profile=mcp-app";

type Row = { id: string; data: Record<string, unknown> };

/** What the page draws for one design. */
export type ViewDesign = {
  status: "waiting" | "built" | "designing";
  request?: string;
  open?: string;
  notCovered?: string[];
  format: { locale: string; currency: string };
  parts: Array<{
    title: string;
    lines: string[];
    columns: Array<{ field: string; label: string; type: string }>;
    rows: Row[];
    screen?: { title: string; html: string };
  }>;
};

const SAMPLE = 20;

/** A few rows of a section as it is: its own, or the store's with the owner's fields beside them. */
async function sampleRows(db: SupabaseClient, projectId: string, mod: ModuleRow): Promise<Row[]> {
  if (isStoreTable(mod.source_table)) {
    const { data: store } = await db
      .from("stores")
      .select("id")
      .eq("project_id", projectId)
      .in("status", ["connected", "uninstalled"])
      .maybeSingle();
    if (!store) return [];
    const { rows } = await readStoreRows(db, store.id as string, mod.source_table, SAMPLE);
    return withOwnFields(db, mod.id, rows);
  }
  const { data } = await db
    .from("records")
    .select("id, data")
    .eq("module_id", mod.id)
    .is("store_row_id", null)
    .order("created_at", { ascending: false })
    .limit(SAMPLE);
  return (data ?? []).map((r) => ({ id: r.id as string, data: (r.data ?? {}) as Record<string, unknown> }));
}

/**
 * What the page draws for these plans: each part's words, the fields it
 * shows and a few rows (the section it changes, read as it is; a section
 * the same design makes, from the rows it seeds), and a written screen.
 */
export async function designForView(
  db: SupabaseClient,
  projectId: string,
  modules: ModuleRow[],
  plans: AssistantPlan[],
  view: Omit<ViewDesign, "parts">
): Promise<ViewDesign> {
  const parts: ViewDesign["parts"] = [];
  for (const plan of plans) {
    const words = describeForOwner(plan, modules);
    const slug = plan.targetModuleId?.startsWith("#") ? plan.targetModuleId.slice(1) : null;
    const made = slug ? plans.find((p) => p.changeType === "NEW_MODULE" && p.newModule?.name === slug) : undefined;
    const target = modules.find((m) => m.id === plan.targetModuleId);
    let section: UiSchema | null = null;
    let rows: Row[] = [];
    if (plan.changeType === "NEW_MODULE") {
      rows = (plan.newRecords ?? []).map((data, i) => ({ id: `new-${i}`, data }));
    } else if (made) {
      section = { columns: made.newSchema?.columns ?? [], features: made.features ?? null };
      rows = (made.newRecords ?? []).map((data, i) => ({ id: `new-${i}`, data }));
    } else if (target) {
      const { data: latest } = await db
        .from("ui_schemas")
        .select("schema_json")
        .eq("module_id", target.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const saved = (latest?.schema_json as UiSchema | undefined) ?? { columns: [] };
      const columns = isStoreTable(target.source_table)
        ? storeSectionColumns(target.source_table, saved.columns)
        : saved.columns;
      section = { ...saved, columns };
      rows = await sampleRows(db, projectId, target);
    }
    const shown = changeShown(plan, section);
    const v = shown?.features?.view;
    parts.push({
      title: words.title,
      lines: words.lines,
      columns: (shown?.columns ?? []).map((c) => ({ field: c.field, label: c.label, type: c.type })),
      rows,
      ...(v?.type === "custom" ? { screen: { title: v.title, html: v.html } } : {}),
    });
  }
  return { ...view, parts };
}

/** The app's colours, light and dark, by the names a written screen uses (lib/custom-view); the screen check (lib/ux-review) draws in the light ones. */
export const TOKENS = {
  light: {
    fg: "hsl(0 0% 19%)",
    "fg-muted": "hsl(0 0% 38%)",
    "fg-faint": "hsl(0 0% 54%)",
    surface: "hsl(0 0% 100%)",
    "surface-subdued": "hsl(0 0% 97%)",
    "surface-hover": "hsl(0 0% 95%)",
    line: "hsl(0 0% 89%)",
    "line-strong": "hsl(0 0% 80%)",
    primary: "hsl(0 0% 19%)",
    "primary-hover": "hsl(0 0% 28%)",
    "on-primary": "hsl(0 0% 100%)",
    focus: "hsl(214 100% 50%)",
    link: "hsl(214 100% 45%)",
    "critical-solid": "hsl(357 84% 42%)",
    success: "hsl(141 94% 84%)",
    "success-fg": "hsl(153 98% 16%)",
    critical: "hsl(2 94% 92%)",
    "critical-fg": "hsl(350 86% 30%)",
    attention: "hsl(33 100% 82%)",
    "attention-fg": "hsl(40 100% 18%)",
    info: "hsl(208 100% 94%)",
    "info-fg": "hsl(201 100% 24%)",
    neutral: "hsl(0 0% 89%)",
    "neutral-fg": "hsl(0 0% 38%)",
    "shadow-card": "0 1px 2px hsl(0 0% 0% / 0.06), 0 0 0 1px hsl(0 0% 0% / 0.05)",
    "shadow-control": "0 1px 1px hsl(0 0% 0% / 0.05)",
    "shadow-dialog": "0 12px 32px hsl(0 0% 0% / 0.18)",
  },
  dark: {
    fg: "hsl(0 0% 93%)",
    "fg-muted": "hsl(0 0% 67%)",
    "fg-faint": "hsl(0 0% 50%)",
    surface: "hsl(0 0% 12.5%)",
    "surface-subdued": "hsl(0 0% 11%)",
    "surface-hover": "hsl(0 0% 16%)",
    line: "hsl(0 0% 20%)",
    "line-strong": "hsl(0 0% 30%)",
    primary: "hsl(0 0% 92%)",
    "primary-hover": "hsl(0 0% 82%)",
    "on-primary": "hsl(0 0% 9%)",
    focus: "hsl(214 100% 62%)",
    link: "hsl(214 100% 70%)",
    "critical-solid": "hsl(357 72% 52%)",
    success: "hsl(150 42% 14%)",
    "success-fg": "hsl(145 60% 64%)",
    critical: "hsl(355 45% 17%)",
    "critical-fg": "hsl(355 100% 78%)",
    attention: "hsl(33 55% 17%)",
    "attention-fg": "hsl(36 100% 72%)",
    info: "hsl(210 50% 17%)",
    "info-fg": "hsl(205 100% 76%)",
    neutral: "hsl(0 0% 20%)",
    "neutral-fg": "hsl(0 0% 72%)",
    "shadow-card": "0 0 0 1px hsl(0 0% 100% / 0.08)",
    "shadow-control": "0 0 0 1px hsl(0 0% 100% / 0.06)",
    "shadow-dialog": "0 12px 32px hsl(0 0% 0% / 0.5)",
  },
} as const;

const vars = (t: Record<string, string>) =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

const STYLE = `:root{${vars(TOKENS.light)}--radius-card:0.75rem;--radius-control:0.5rem;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:var(--font);color-scheme:light}
:root[data-theme=dark]{${vars(TOKENS.dark)}color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(TOKENS.dark)}color-scheme:dark}}
body{margin:0;background:transparent;color:var(--fg);font:14px/1.45 var(--font)}
.d{padding:12px;display:grid;gap:10px}
.state{font-size:12px;color:var(--fg-muted);display:flex;align-items:center;gap:6px}.state b{color:var(--fg)}
.dot{width:6px;height:6px;border-radius:99px;background:var(--focus)}
.ask{font-size:13px;color:var(--fg-muted);border-left:2px solid var(--line);padding-left:8px}
.part{background:var(--surface);border-radius:var(--radius-card);box-shadow:var(--shadow-card);overflow:hidden}
.part h3{margin:0;padding:10px 12px 2px;font-size:13px;font-weight:600}
.part ul{margin:0;padding:0 12px 8px 26px;font-size:12px;color:var(--fg-muted)}
.part table{width:100%;border-collapse:collapse;font-size:12px}.part th{text-align:left;font-weight:500;color:var(--fg-muted);padding:6px 12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--surface-subdued)}
.part td{padding:6px 12px;border-bottom:1px solid var(--line);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.screen{border-top:1px solid var(--line);max-height:420px;overflow:auto}
.gap{font-size:12px;color:var(--attention-fg)}
.open{justify-self:start;font:inherit;font-size:13px;font-weight:500;padding:6px 12px;border-radius:var(--radius-control);border:0;background:var(--primary);color:var(--on-primary);cursor:pointer}`;

/** The view: handshake, theme, the design drawn, a screen run read-only, its size said. */
const SCRIPT = `(() => {
  const post = (m) => parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  let seq = 0; const waiting = new Map();
  const ask = (method, params) => new Promise((done) => { const id = ++seq; waiting.set(id, done); post({ id, method, params }); });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
  const root = document.getElementById("d");
  const cell = (v) => v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
  let screenShown = false;
  function runScreen(box, html, columns, rows, format) {
    // Read only, over the rows it was handed: a preview saves nothing and reaches nothing.
    window.wl = {
      columns,
      onRows(fn) { try { fn(rows); } catch (e) { console.error(e); } },
      find: async (f, v, section) => section ? [] : rows.filter((r) => String(r.data[f] ?? "").toLowerCase() === String(v).toLowerCase() || String(r.data[f] ?? "") === "#" + String(v).replace(/^#/, "")),
      read: async () => [],
      set: async () => { throw new Error("This is a preview: nothing is saved."); },
      add: async () => { throw new Error("This is a preview: nothing is saved."); },
      ask: async () => false,
      money: (n, c) => new Intl.NumberFormat(format.locale, { style: "currency", currency: c || format.currency, maximumFractionDigits: 2 }).format(Number(n) || 0),
      currency: format.currency,
    };
    const t = document.createElement("template"); t.innerHTML = html;
    const scripts = [...t.content.querySelectorAll("script")];
    scripts.forEach((s) => s.remove());
    box.append(t.content);
    for (const s of scripts) { const run = document.createElement("script"); run.textContent = s.textContent; box.append(run); }
  }
  function draw(d) {
    if (!d) return;
    root.textContent = "";
    const state = el("div", "state"); state.append(el("span", "dot"));
    const b = el("b", null, d.status === "designing" ? "Still designing" : d.status === "built" ? "Built" : "Waiting for your yes");
    state.append(b, document.createTextNode(d.status === "designing" ? " · it lands in Warmluke when done" : " · nothing is built until you approve it"));
    root.append(state);
    if (d.request) root.append(el("div", "ask", d.request));
    for (const p of d.parts || []) {
      const box = el("section", "part");
      box.append(el("h3", null, p.title));
      if (p.lines && p.lines.length) { const ul = el("ul"); for (const l of p.lines) ul.append(el("li", null, l)); box.append(ul); }
      if (p.screen && !screenShown) {
        screenShown = true;
        const s = el("div", "screen"); box.append(s);
        runScreen(s, p.screen.html, p.columns, p.rows || [], d.format);
      } else if (p.columns && p.columns.length) {
        const cols = p.columns.slice(0, 6); const table = el("table"); const head = el("tr");
        for (const c of cols) head.append(el("th", null, c.label));
        table.append(head);
        for (const r of (p.rows || []).slice(0, 3)) { const tr = el("tr"); for (const c of cols) tr.append(el("td", null, cell(r.data[c.field]))); table.append(tr); }
        box.append(table);
      }
      root.append(box);
    }
    if (d.notCovered && d.notCovered.length) root.append(el("div", "gap", "Not covered: " + d.notCovered.join(" · ")));
    if (d.open) { const o = el("button", "open", "Open in Warmluke"); o.onclick = () => ask("ui/open-link", { url: d.open }); root.append(o); }
  }
  addEventListener("message", (e) => {
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m.result || null); waiting.delete(m.id); return; }
    if (m.method === "ui/notifications/tool-result") draw(m.params && m.params.structuredContent && m.params.structuredContent.design);
  });
  ask("ui/initialize", { protocolVersion: "2026-01-26", clientInfo: { name: "warmluke-design", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] } }).then((r) => {
    const theme = r && r.hostContext && r.hostContext.theme;
    if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
    post({ method: "ui/notifications/initialized", params: {} });
  });
  new ResizeObserver(() => post({ method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } })).observe(document.body);
})();`;

/** The page the host draws beside a design's answer. */
export function designViewHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}${CUSTOM_VIEW_KIT}</style></head><body><div class="d" id="d"><div class="state"><span class="dot"></span><b>Opening the design…</b></div></div><script>${SCRIPT}</script></body></html>`;
}
