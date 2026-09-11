"use client";

// ─────────────────────────────────────────────────────────────
// A draggable edge for a fixed-width panel. Width is remembered per
// panel in localStorage, so the split someone sets survives a reload.
// Below the lg breakpoint the panels are drawers, so the handle is
// hidden and the stored width ignored.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

export function useResizable({
  storageKey,
  initial,
  min,
  max,
  /** "left" grows as the pointer moves right; "right" is the mirror. */
  edge,
  /**
   * Widest this panel may get right now, given what else is on screen.
   * Two panels each clamped only to their own maximum can still squeeze
   * the middle to nothing on a narrow laptop, so the caller passes what
   * the other panel is currently taking.
   */
  liveMax,
}: {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  edge: "left" | "right";
  liveMax?: () => number;
}) {
  const [width, setWidth] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);
  // The handler must start from the CURRENT width. Reading it from the
  // state closure meant a drag begun before React had re-rendered
  // started from the previous width and jumped.
  const widthRef = useRef(initial);

  const applyWidth = useCallback((w: number) => {
    widthRef.current = w;
    setWidth(w);
  }, []);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) applyWidth(saved);
    } catch {
      /* private mode, blocked storage — the default is fine */
    }
  }, [storageKey, min, max, applyWidth]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const startX = e.clientX;
      const startWidth = widthRef.current;
      let latest = startWidth;

      // Listeners go on window, not the handle: the pointer routinely
      // leaves a 6px strip mid-drag, and pointer capture is a best-effort
      // extra — it throws outright when there is no live pointer, which
      // would abort the whole drag if it were load-bearing.
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* capture unavailable; window listeners still cover the drag */
      }

      const move = (ev: PointerEvent) => {
        const delta = edge === "left" ? ev.clientX - startX : startX - ev.clientX;
        const ceiling = Math.max(min, Math.min(max, liveMax ? liveMax() : max));
        latest = Math.min(ceiling, Math.max(min, startWidth + delta));
        // One update per frame: pointermove fires far faster than the
        // browser can lay the page out.
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => applyWidth(latest));
      };

      const up = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* nothing captured */
        }
        applyWidth(latest);
        try {
          localStorage.setItem(storageKey, String(latest));
        } catch {
          /* ignore */
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [min, max, edge, storageKey, applyWidth, liveMax]
  );

  const reset = useCallback(() => {
    applyWidth(initial);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [initial, storageKey, applyWidth]);

  return { width, dragging, onPointerDown, reset };
}

/** The grab strip itself — invisible until hovered. */
export function resizeHandleClass(edge: "left" | "right", dragging: boolean): string {
  return [
    "absolute inset-y-0 z-50 hidden w-1.5 cursor-col-resize lg:block",
    edge === "left" ? "-right-0.5" : "-left-0.5",
    "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
    dragging ? "after:bg-blue-500" : "after:bg-transparent hover:after:bg-blue-400/60",
  ].join(" ");
}
