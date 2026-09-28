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

import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_VIEW_TOKENS, customViewPage, customViewProblem } from "@/lib/custom-view";
import { withComputed } from "@/lib/expr";
import type { RecordRow, SchemaColumn } from "@/lib/types";

type Call = { wl: 1; id: number; call: "find" | "set" | "add"; args: unknown[] };

/** The app's colours now, light or dark, by the names the screen was told. */
function colours(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(CUSTOM_VIEW_TOKENS).map(([name, token]) => [name, css.getPropertyValue(token).trim()])
  );
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
}: {
  view: { title: string; html: string };
  columns: SchemaColumn[];
  records: RecordRow[];
  onSet?: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onAdd?: (fields: Record<string, unknown>) => Promise<void>;
  onFind?: (field: string, code: string) => Promise<RecordRow[]>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState<string | null>(null);
  const problem = customViewProblem(view.html);

  // Built in the browser: the colours are the page's as it is now.
  useEffect(() => {
    if (!problem) setPage(customViewPage(view.html, columns, colours()));
  }, [view.html, columns, problem]);

  const rows = useMemo(() => asRows(records, columns), [records, columns]);
  const send = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
  useEffect(() => {
    send({ wl: 1, type: "rows", rows });
  }, [rows]);

  // The handlers as they are now, read by the listener when a call arrives.
  const handlers = useRef({ onSet, onAdd, onFind, columns });
  useEffect(() => {
    handlers.current = { onSet, onAdd, onFind, columns };
  }, [onSet, onAdd, onFind, columns]);

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
      <div className="rounded-xl border border-line bg-surface p-4 text-[13px] text-fg-muted">
        This screen was not shown: {problem}
      </div>
    );
  }
  return (
    <iframe
      ref={frame}
      title={view.title}
      sandbox="allow-scripts"
      srcDoc={page ?? undefined}
      onLoad={() => {
        send({ wl: 1, type: "rows", rows });
        // A scanner types into whatever has focus; the screen is where it goes.
        frame.current?.focus();
      }}
      className="h-[70vh] min-h-[420px] w-full rounded-xl border border-line bg-surface"
    />
  );
}
