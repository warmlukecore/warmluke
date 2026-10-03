// The screen check: a written screen, seen as its owner would see it,
// and sent back once, with one fix, when it is plainly wrong.
//
// Merchants said Luke's screens looked rough: a grey dropdown, PENDING and
// 2026-10-02 printed as stored, an order number broken over two lines, a
// table with nothing in it and nothing said, a bar over the last row. The
// critic reads a design as words and cannot see any of that. So each
// written screen in a design (two at most) is built exactly as the app
// builds it (customViewPage, in a sealed frame, fed its rows through
// window.wl), over the section's own rows or the design's demo rows,
// photographed at a laptop's width and a phone's in a sandboxed browser
// of ours (lib/screen-shot.ts: a renderer we call, never a tool a model
// can, with the network denied), and looked at by a vision model against
// the written-screen rules (CUSTOM_VIEW_GUIDE, docs/design/design-system.md
// "Screens Luke writes").
//
// When the sandbox cannot be had, or is slow, the screen's HTML and CSS
// are read instead, on the same model and rules, for what the code makes
// certain. With ANTHROPIC_UX_MODEL unset (ctx.uxModel null) nothing runs.
// It never throws: a design the owner can read beats none, so anything
// unexpected is "skipped", said in the log under [ux].
//
// Callers: src/lib/review-gate.ts.

import { callModel, stripFences, type ChatTurn } from "@/lib/ai";
import { customViewPage } from "@/lib/custom-view";
import { designForView, TOKENS } from "@/lib/design-view";
import { withComputed } from "@/lib/expr";
import type { ReviewContext, UxVerdict } from "@/lib/review-types";
import { FACES_HERE, shootScreen, type Shot } from "@/lib/screen-shot";
import type { AssistantPlan, SchemaColumn } from "@/lib/types";
import { asJob } from "@/lib/usage";

type Row = { id: string; data: Record<string, unknown> };
type Column = { field: string; label: string; type: string };

/** A written screen of the design, with what it is drawn over. */
export type Screen = {
  title: string;
  html: string;
  columns: Column[];
  rows: Row[];
};

/** A laptop, and a phone. */
export const UX_WIDTHS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
];
/** Screens looked at in one design: the rest are rare, and each costs a look. */
const MAX_SCREENS = 2;
/** Rows a screen is drawn over: enough to see a list as a list. */
const MAX_ROWS = 30;
/** How long the pictures may take before the code is read instead. */
const SHOOT_MS = 30_000;
/** The whole check, both screens and their looks, before it gives up and says skipped. */
const BUDGET_MS = 75_000;
const MAX_ISSUES = 6;
const MAX_FIX = 300;

// ── What is looked at ─────────────────────────────────────────

const hasScreen = (p: AssistantPlan) =>
  p.features?.view?.type === "custom" || (p.features?.tabs ?? []).some((t) => t.type === "custom");

/**
 * The written screens in these plans, each with its fields and the rows
 * it would be drawn over: a section's own (or the store's, with the
 * owner's fields beside them), read through the caller's client; for a
 * section the design makes, its demo rows, or a few made up from its
 * fields. Rows are redacted and their computed fields worked out, as the
 * frame would be handed them.
 */
export async function findScreens(ctx: ReviewContext, plans: AssistantPlan[]): Promise<Screen[]> {
  // Only plans with a screen, and the new sections a screen may be laid
  // over: the rest would be read for nothing.
  const wanted = plans.filter((p) => hasScreen(p) || p.changeType === "NEW_MODULE");
  if (!wanted.some(hasScreen)) return [];
  const design = await designForView(ctx.db, ctx.projectId, ctx.modules, wanted, {
    status: "waiting",
    format: { locale: ctx.locale, currency: ctx.currency },
  });
  const screens: Screen[] = [];
  wanted.forEach((plan, i) => {
    const part = design.parts[i];
    // A new section's screen kept as a tab, which the preview's part leaves out.
    const tab = plan.features?.tabs?.find((t) => t.type === "custom");
    const screen = part?.screen ?? (plan.changeType === "NEW_MODULE" && tab?.type === "custom" ? tab : undefined);
    if (!part || !screen || screens.length >= MAX_SCREENS) return;
    const slug = plan.targetModuleId?.startsWith("#") ? plan.targetModuleId.slice(1) : null;
    const made = slug ? plans.find((p) => p.changeType === "NEW_MODULE" && p.newModule?.name === slug) : undefined;
    const known: SchemaColumn[] = [
      ...(plan.newSchema?.columns ?? []),
      ...(made?.newSchema?.columns ?? []),
      ...(ctx.schemas.get(plan.targetModuleId ?? "")?.columns ?? []),
    ];
    const fresh = plan.changeType === "NEW_MODULE" || !!made;
    const rows = part.rows.length || !fresh ? part.rows : madeUpRows(part.columns);
    screens.push({
      title: screen.title,
      html: screen.html,
      columns: part.columns,
      rows: rows
        .slice(0, MAX_ROWS)
        .map((r) => ({ id: r.id, data: withComputed(known, redact(r.data) as Row["data"]) })),
    });
  });
  return screens;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const PERSONAL = /e-?mail|phone|mobile|whatsapp|address|zip|post_?code|postal|pin_?code/i;
/** Its shape kept, its digits not anyone's. */
const otherDigits = (s: string) => s.replace(/\d/g, (_d, at: number) => "9876543210"[at % 10]);

/**
 * A row's people taken out: emails and phone numbers (and anything kept
 * under such a name, or an address) become look-alikes of the same
 * shape. Layout needs their length, not whose they are, and the
 * pictures go to the model.
 */
export function redact(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v !== "string") return v;
  if (PERSONAL.test(key)) {
    if (/mail/i.test(key) || v.includes("@")) return "customer@example.com";
    return /[a-z]{3}/i.test(v) ? "12 Sample Street, Mumbai 400001" : otherDigits(v);
  }
  const mailed = v.replace(EMAIL, "customer@example.com");
  // A date's eight digits are not a phone's.
  if (/^\d{4}-\d{2}-\d{2}/.test(mailed)) return mailed;
  return mailed.replace(PHONE, (m) => ((m.match(/\d/g)?.length ?? 0) >= 9 ? otherDigits(m) : m));
}

const SAMPLE: Record<string, (i: number, label: string) => unknown> = {
  text: (i, label) => `${label} ${i + 1}`,
  longtext: () => "A short note about this one.",
  number: (i) => [3, 12, 1, 7, 24][i % 5],
  currency: (i) => [1299, 450, 8999.5, 120, 2350][i % 5],
  percent: (i) => [15, 40, 5, 100, 62][i % 5],
  date: (i) => new Date(Date.now() - i * 2 * 86_400_000).toISOString().slice(0, 10),
  time: (i) => ["09:30", "11:00", "14:15", "16:45", "18:00"][i % 5],
  boolean: (i) => i % 2 === 0,
  badge: (i) => ["Open", "Done", "Waiting"][i % 3],
  dropdown: (i) => ["Open", "Done", "Waiting"][i % 3],
  phone: () => "+91 98765 43210",
  email: (i) => `customer${i + 1}@example.com`,
  url: (i) => `example.com/item-${i + 1}`,
  barcode: (i) => `89012340${10000 + i}`,
};

/** A few rows made up from a new section's fields, for a design that seeded none. */
export function madeUpRows(columns: Column[], count = 5): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sample-${i}`,
    data: Object.fromEntries(columns.map((c) => [c.field, SAMPLE[c.type]?.(i, c.label) ?? null])),
  }));
}

/** JSON as a script may hold it: nothing in it can end the script. */
const inScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * The page the browser opens: the screen's own page (customViewPage, as
 * CustomView builds it, in the app's light face) in a frame sealed as the
 * app seals it, with this page in the app's place: it hands the frame its
 * rows, finds in them, and answers a write as a preview does. Another
 * section's rows are not read here; a list fed by one is drawn empty.
 */
export function screenDocument(screen: Screen, format: { locale: string; currency: string }): string {
  const page = customViewPage(
    screen.html,
    screen.columns,
    { ...TOKENS.light, "radius-card": "0.75rem", "radius-control": "0.5rem" },
    FACES_HERE,
    format,
    "light"
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe sandbox="allow-scripts" title="screen"></iframe><script>
const frame = document.querySelector("iframe");
const rows = ${inScript(screen.rows)};
const send = (m) => frame.contentWindow.postMessage(m, "*");
addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.wl !== 1 || typeof m.id !== "number" || !Array.isArray(m.args)) return;
  const answer = (ok, value, error) => send({ wl: 1, id: m.id, ok, value, error });
  if (m.call === "read" || (m.call === "find" && m.args.length === 3)) return answer(true, []);
  if (m.call === "find") {
    const field = String(m.args[0]), code = String(m.args[1]).toLowerCase();
    return answer(true, rows.filter((r) => String(r.data[field] ?? "").toLowerCase() === code));
  }
  answer(false, undefined, "This screen can only read here.");
});
frame.addEventListener("load", () => {
  send({ wl: 1, type: "rows", rows });
  setTimeout(() => (document.body.dataset.ready = "1"), 50);
});
frame.srcdoc = ${inScript(page)};
</script></body></html>`;
}

// ── How it is looked at ───────────────────────────────────────

const STANCE = `You review one screen of a small business's own internal app, as its owner would on first opening it. You report defects only: never guess at what you cannot see, never report what you are not sure of, never ask for a feature, a field, a step or words the screen does not have, and never judge taste.`;

/** From the written-screen rules (CUSTOM_VIEW_GUIDE, docs/design/design-system.md) and what merchants said. */
const LOOK_FOR = `Look for these defects, and only these:
- A stored value printed raw: a status code in capitals (PENDING, PARTIALLY_REFUNDED), an ISO date or time (2026-10-02, 2026-10-02T09:14:00Z), money with no currency format.
- A code, a date, an amount or a button's words broken over two lines.
- A list or table with no rows and no words saying why or what to do.
- A column, panel or heading with nothing under it, like an Actions column with no buttons.
- Something laid over the content: a fixed bar over the last row, a toolbar sitting on a card's corner, text over text.
- Text too small to read, or anything cut off, squeezed or running off the side at the phone's width (a table scrolling sideways in its own box is fine).
- A form with no shape: inputs with no words saying what they are, fields run together on one line, no clear button to finish.
- The browser's own controls where the app's belong: a plain grey dropdown, unstyled buttons or checkboxes.
- On a screen built for one job, nothing big: the count or the next thing to do the same size as everything else; or several things shouting at once.
- Colour as the only signal: a red or green row, dot or badge with no word saying what it means.`;

const ANSWER = `"redo" only when the owner would plainly be hindered: they cannot read something, cannot tell what to do next, or the phone's width breaks the screen. A blemish that does not hinder is an issue on a "pass".

Reply with JSON only, no prose:
{"verdict":"pass"|"redo","issues":["…"],"fix":"…"|null}
- issues: each one short line saying what and where ("the Status column prints PENDING"); [] when there are none.
- fix: on "redo", one line to the designer naming the change that matters most, under 300 characters; null on "pass".`;

export const UX_RUBRIC_SHOTS = `${STANCE} You are shown pictures of it: report only what the pictures show.\n\n${LOOK_FOR}\n\n${ANSWER}`;

export const UX_RUBRIC_CODE = `${STANCE} You are shown its HTML, CSS and script, not a picture: report only what the code makes certain (what it will print, how its CSS lays it out), never what depends on data you are not shown.

It runs inside the app's kit, which already styles headings, inputs, buttons, selects and tables, and gives classes (wl-page, wl-card, wl-list, wl-row, wl-table, wl-form, wl-field, wl-empty, wl-big, wl-count, wl-banner, wl-badge, wl-button). A <select> is drawn as the app's own list, never the browser's. wl.date(v), wl.label(v) and wl.money(n) print a date, a status and money as the app does: a value passed through them is not raw. A table in wl-table scrolls sideways on a phone; td class "num" or "date" keeps its value on one line.

${LOOK_FOR}

${ANSWER}`;

/** What the model is told of the screen beside the pictures. */
function shotWords(s: Screen, shots: Shot[]): string {
  const sizes = shots.map((x) => `${x.w}×${x.h}`).join(", then ");
  return `The screen "${s.title}", drawn over ${s.rows.length} of its rows${s.rows.length ? "" : " (none: what shows is its empty state)"}: ${sizes} pixels, a laptop's width and then a phone's (the phone's picture runs on below its first screen). Rows it reads from other sections are not drawn here: a list fed only by another section is empty, and that is not a defect.`;
}

/** What the model is told of the screen when there are no pictures. */
function codeWords(s: Screen): string {
  return `The screen "${s.title}". A few of the rows it is given (wl.onRows), as stored:\n${JSON.stringify(s.rows.slice(0, 3)).slice(0, 3000)}\n\nIts HTML, CSS and script:\n${s.html.slice(0, 30_000)}`;
}

type Verdict = Omit<UxVerdict, "how" | "ms">;

/** The model's answer as a verdict, or null when it is not one. */
export function parseUxVerdict(raw: string): Verdict | null {
  const text = stripFences(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    // Words around the JSON: the object inside them.
    try {
      obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as { verdict?: unknown; issues?: unknown; fix?: unknown };
  if (o.verdict !== "pass" && o.verdict !== "redo") return null;
  const issues = (Array.isArray(o.issues) ? o.issues : [])
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim().slice(0, 200))
    .slice(0, MAX_ISSUES);
  const said = typeof o.fix === "string" && o.fix.trim() ? o.fix.trim() : null;
  const fix = o.verdict === "redo" ? (said ?? issues[0] ?? null) : null;
  // Sent back with nothing to change is not sent back.
  if (o.verdict === "redo" && !fix) return { verdict: "pass", issues, fix: null };
  return { verdict: o.verdict, issues, fix: fix ? fix.slice(0, MAX_FIX) : null };
}

/** Each screen's verdict as one: back if any goes back, issues together, one line to the designer. */
export function combineVerdicts(
  seen: Array<(Verdict & { how: "screenshot" | "text"; title: string }) | null>
): Verdict & {
  how: UxVerdict["how"];
} {
  const got = seen.filter((v) => v !== null);
  if (!got.length) return { verdict: "skipped", how: "none", issues: [], fix: null };
  const named = (v: { title: string }, line: string) => (got.length > 1 ? `${v.title}: ${line}` : line);
  const issues = [...new Set(got.flatMap((v) => v.issues.map((i) => named(v, i))))].slice(0, MAX_ISSUES);
  const back = got.filter((v) => v.verdict === "redo");
  const fix = back.length
    ? back
        .map((v) => named(v, v.fix ?? ""))
        .join(" ")
        .slice(0, MAX_FIX)
    : null;
  return {
    verdict: back.length ? "redo" : "pass",
    how: got.every((v) => v.how === "screenshot") ? "screenshot" : "text",
    issues,
    fix,
  };
}

/** A promise that gives up after `ms`, saying why. */
const within = <T>(p: Promise<T>, ms: number, why: string) =>
  new Promise<T>((ok, no) => {
    const t = setTimeout(() => no(new Error(why)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e) => {
        clearTimeout(t);
        no(e);
      }
    );
  });

/** What the check calls out to, handed in by a check in their place. */
export type ReviewDeps = {
  shoot: typeof shootScreen;
  look: (model: string, system: string, turn: ChatTurn, signal?: AbortSignal) => Promise<string>;
  shootMs: number;
  budgetMs: number;
};

const lookAt: ReviewDeps["look"] = (model, system, turn, signal) => callModel({ system, turns: [turn], model, signal });

/**
 * The written screens in a design, looked at. Skipped at once when the
 * setting is off or there is no written screen; never throws.
 */
export async function reviewScreens(
  ctx: ReviewContext,
  plans: AssistantPlan[],
  deps: Partial<ReviewDeps> = {}
): Promise<UxVerdict> {
  const t0 = Date.now();
  const done = (v: Omit<UxVerdict, "ms">): UxVerdict => ({ ...v, ms: Date.now() - t0 });
  const skipped: Omit<UxVerdict, "ms"> = { verdict: "skipped", how: "none", issues: [], fix: null };
  const model = ctx.uxModel;
  if (!model) return done(skipped);
  const { shoot = shootScreen, look = lookAt, shootMs = SHOOT_MS, budgetMs = BUDGET_MS } = deps;
  const stop = new AbortController();
  const caller = () => stop.abort();
  if (ctx.signal?.aborted) stop.abort();
  ctx.signal?.addEventListener("abort", caller, { once: true });
  const signal = stop.signal;
  const format = { locale: ctx.locale, currency: ctx.currency };

  const one = async (s: Screen) => {
    let shots: Shot[] | null = null;
    try {
      shots = await within(
        shoot(screenDocument(s, format), { widths: UX_WIDTHS, timeoutMs: shootMs, signal }),
        shootMs + 1000,
        "screens unavailable: too slow"
      );
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn(`[ux] ${e instanceof Error ? e.message : String(e)}; reading "${s.title}" as code instead`);
    }
    const turn: ChatTurn = shots
      ? {
          role: "user",
          content: shotWords(s, shots),
          images: shots.map((x) => ({ data: x.png, mediaType: x.mediaType })),
        }
      : { role: "user", content: codeWords(s) };
    try {
      const raw = await asJob("ux", () => look(model, shots ? UX_RUBRIC_SHOTS : UX_RUBRIC_CODE, turn, signal));
      const v = parseUxVerdict(raw);
      if (!v) console.error(`[ux] "${s.title}": not a verdict: ${raw.slice(0, 200)}`);
      return v ? { ...v, how: shots ? ("screenshot" as const) : ("text" as const), title: s.title } : null;
    } catch (e) {
      if (signal.aborted) throw e;
      console.error(`[ux] "${s.title}": ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  try {
    const verdict = await within(
      (async () => {
        const screens = await findScreens(ctx, plans);
        if (!screens.length) return skipped;
        return combineVerdicts(await Promise.all(screens.map(one)));
      })(),
      budgetMs,
      `took longer than ${Math.round(budgetMs / 1000)} seconds`
    );
    return done(verdict);
  } catch (e) {
    console.error(`[ux] skipped: ${ctx.signal?.aborted ? "stopped" : e instanceof Error ? e.message : String(e)}`);
    return done(skipped);
  } finally {
    ctx.signal?.removeEventListener("abort", caller);
    // Whatever is still out (a picture, a look) stops with the check.
    stop.abort();
  }
}
