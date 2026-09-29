"use client";

// ─────────────────────────────────────────────────────────────
// A screen Luke wrote (view type "custom"), in a frame sealed off
// from the app: scripts only, an origin of its own, and a content
// policy it cannot lift (lib/custom-view.ts). It has no network and
// nothing of the app's to reach; it talks through window.wl, whose
// every call arrives here as a message from this frame alone, and is
// answered by the section's own handlers — the same writes, under the
// same rights, as a button on a row. A preview has no handlers, so a
// preview's screen can read and never write.
// ─────────────────────────────────────────────────────────────

import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { button } from "@/components/ui/controls";
import { useFormat } from "@/lib/format";
import { CUSTOM_VIEW_TOKENS, customViewPage, customViewProblem } from "@/lib/custom-view";
import { withComputed } from "@/lib/expr";
import type { RecordRow, SchemaColumn } from "@/lib/types";

type Call = { wl: 1; id: number; call: "find" | "read" | "set" | "add"; args: unknown[] };

/** A preview's height in Luke's panel: enough to read the screen, not the whole panel. */
const PREVIEW_HEIGHT = 420;

/** The app's values now, light or dark, by the names the screen was told. */
function colours(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(CUSTOM_VIEW_TOKENS).map(([name, token]) => [name, css.getPropertyValue(token).trim()])
  );
}

/**
 * The app's two faces, as @font-face rules with their files inline: the
 * frame may load nothing, but a font it is handed is its own. Read once a
 * session from the app's own stylesheet; "" when they cannot be read, and
 * the screen falls back to the system's face.
 */
let facesOnce: Promise<string> | null = null;
function appFaces(): Promise<string> {
  facesOnce ??= (async () => {
    const css = getComputedStyle(document.documentElement);
    const rules = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .filter((r): r is CSSFontFaceRule => r instanceof CSSFontFaceRule);
    const out: string[] = [];
    for (const [variable, name] of [
      ["--font-manrope", "WL Sans"],
      ["--font-bricolage", "WL Display"],
    ]) {
      const family = css
        .getPropertyValue(variable)
        .split(",")[0]
        .trim()
        .replace(/^['"]|['"]$/g, "");
      const mine = rules.filter((r) => r.style.getPropertyValue("font-family").replace(/['"]/g, "").trim() === family);
      // The Latin file: the one whose range starts at U+0000, or the only one there is.
      const rule = mine.find((r) => /U\+0+-/i.test(r.style.getPropertyValue("unicode-range"))) ?? mine[0];
      const src = rule && /url\(["']?([^"')]+)/.exec(rule.style.getPropertyValue("src"))?.[1];
      if (!src) continue;
      // Written relative to its stylesheet, not to the page: a built app's
      // CSS says "../media/…", which from /app/… is a file that is not there.
      const res = await fetch(new URL(src, rule.parentStyleSheet?.href ?? document.baseURI).href);
      if (!res.ok) continue;
      const blob = await res.blob();
      const data = await new Promise<string>((ok, no) => {
        const read = new FileReader();
        read.onload = () => ok(String(read.result));
        read.onerror = no;
        read.readAsDataURL(blob);
      });
      out.push(
        `@font-face{font-family:"${name}";src:url(${data}) format("woff2");font-weight:100 900;font-display:block}`
      );
    }
    return out.join("");
  })().catch(() => "");
  return facesOnce;
}

const asRows = (rows: RecordRow[], columns: SchemaColumn[]) =>
  rows.map((r) => ({ id: r.id, data: withComputed(columns, r.data ?? {}) }));

export default function CustomView({
  view,
  columns,
  records,
  onSet,
  onAdd,
  onFind,
  onRead,
  preview = false,
}: {
  view: { title: string; html: string };
  columns: SchemaColumn[];
  records: RecordRow[];
  onSet?: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onAdd?: (fields: Record<string, unknown>) => Promise<void>;
  onFind?: (field: string, code: string) => Promise<RecordRow[]>;
  /**
   * Another section of this app, read as the owner reads it: its rows,
   * worked out, or those whose field is a code. Read only.
   */
  onRead?: (
    section: string,
    match?: { field: string; code: string }
  ) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  /** A proposal's preview, in Luke's panel: a card of its own size, and it leaves the owner's focus where it is. */
  preview?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const problem = customViewProblem(view.html);
  const fmt = useFormat();

  // Built in the browser: the values are the page's as it is now, and the
  // faces are waited for (a moment, once) so the screen never reloads to
  // take them: a reload would lose where its user was.
  useEffect(() => {
    if (problem) return;
    let alive = true;
    const late = new Promise<string>((done) => setTimeout(() => done(""), 2000));
    void Promise.race([appFaces(), late]).then((faces) => {
      if (alive)
        setPage(customViewPage(view.html, columns, colours(), faces, { locale: fmt.locale, currency: fmt.currency }));
    });
    return () => {
      alive = false;
    };
  }, [view.html, columns, problem, fmt.locale, fmt.currency]);

  // The screen is the section: it takes the page below it, and the whole
  // screen when asked (a tablet at a packing desk).
  useEffect(() => {
    const fit = () => {
      const top = Math.max(0, box.current?.getBoundingClientRect().top ?? 0);
      setHeight(Math.max(480, Math.round(window.innerHeight - top - 56)));
    };
    const onFull = () => {
      setFull(document.fullscreenElement === box.current);
      // Back to the screen, where a scanner types.
      frame.current?.focus();
    };
    if (preview) return;
    fit();
    window.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("fullscreenchange", onFull);
    };
  }, [preview]);

  const rows = useMemo(() => asRows(records, columns), [records, columns]);
  const send = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
  useEffect(() => {
    send({ wl: 1, type: "rows", rows });
  }, [rows]);

  // The handlers as they are now, read by the listener when a call arrives.
  const handlers = useRef({ onSet, onAdd, onFind, onRead, columns });
  useEffect(() => {
    handlers.current = { onSet, onAdd, onFind, onRead, columns };
  }, [onSet, onAdd, onFind, onRead, columns]);

  useEffect(() => {
    const listen = async (e: MessageEvent) => {
      // Only this frame, and only calls shaped like window.wl's.
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as Call;
      if (!m || m.wl !== 1 || typeof m.id !== "number" || !Array.isArray(m.args)) return;
      const answer = (ok: boolean, value?: unknown, error?: string) => send({ wl: 1, id: m.id, ok, value, error });
      const h = handlers.current;
      const fields = (v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      try {
        if (m.call === "read" || (m.call === "find" && m.args.length === 3)) {
          const section = m.call === "read" ? m.args[0] : m.args[2];
          const [field, code] = m.args;
          if (!h.onRead || typeof section !== "string")
            return answer(false, undefined, "Other sections are not open here.");
          if (m.call === "find" && (typeof field !== "string" || typeof code !== "string"))
            return answer(false, undefined, "find needs a field and a code.");
          return answer(
            true,
            await h.onRead(section, m.call === "find" ? { field: field as string, code: code as string } : undefined)
          );
        }
        if (m.call === "find") {
          const [field, code] = m.args;
          if (!h.onFind || typeof field !== "string" || typeof code !== "string")
            return answer(false, undefined, "Finding rows is not open here.");
          return answer(true, asRows(await h.onFind(field, code), h.columns));
        }
        if (m.call === "set") {
          const [id, set] = m.args;
          if (!h.onSet) return answer(false, undefined, "This screen can only read here.");
          if (typeof id !== "string" || !fields(set)) return answer(false, undefined, "set needs a row id and fields.");
          await h.onSet(id, fields(set)!);
          return answer(true);
        }
        if (m.call === "add") {
          if (!h.onAdd) return answer(false, undefined, "Rows are not added here.");
          if (!fields(m.args[0])) return answer(false, undefined, "add needs fields.");
          await h.onAdd(fields(m.args[0])!);
          return answer(true);
        }
        answer(false, undefined, "window.wl has no such call.");
      } catch (err) {
        answer(false, undefined, err instanceof Error ? err.message : "That did not save.");
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  if (problem) {
    return (
      <div className="rounded-card bg-surface p-4 text-[13px] text-fg-muted shadow-card">
        This screen was not shown: {problem}
      </div>
    );
  }
  return (
    <div ref={box} className={full ? "flex h-screen flex-col gap-2 bg-canvas p-3" : "flex flex-col gap-2"}>
      {!preview && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => (full ? document.exitFullscreen() : box.current?.requestFullscreen())}
            className={button("plain", "sm")}
          >
            {full ? <Minimize2 aria-hidden size={14} /> : <Maximize2 aria-hidden size={14} />}
            {full ? "Leave full screen" : "Full screen"}
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        title={view.title}
        sandbox="allow-scripts"
        srcDoc={page ?? undefined}
        onLoad={() => {
          send({ wl: 1, type: "rows", rows });
          // A scanner types into whatever has focus; the screen is where it
          // goes. Not a preview's: the owner is typing to Luke beside it.
          if (!preview) frame.current?.focus();
        }}
        style={full ? undefined : { height: preview ? PREVIEW_HEIGHT : (height ?? 480) }}
        className={`w-full rounded-card bg-surface shadow-card ${full ? "flex-1" : ""}`}
      />
    </div>
  );
}
