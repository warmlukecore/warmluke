"use client";

// A small "i" that opens a few lines saying how something is worked out,
// beside what it explains (a stat's number, first). Opened by a press or
// the keyboard, not by hover alone, so a phone can open it too; closed by
// a second press, Escape, a press anywhere else, or the page scrolling.
//
// Placed on the screen, not in its card: inside the card it was as narrow
// as a phone's half-width card and cut off by the section that scrolls
// (7 Oct). Under the "i", as wide as a few lines read well, kept inside
// the window, and above it when there is more room there.
//
// Callers: src/components/GenericRenderer.tsx (stat cards).

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

/** About 18rem: a line of the explanation reads as a line. */
const WIDTH = 288;
const GAP = 8;

type Place = { left: number; width: number; top?: number; bottom?: number; maxHeight: number };

export function InfoTip({ label, title, lines }: { label: string; title: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const b = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - GAP * 2);
    // Its right edge near the "i" (cards put it at their top right), inside the window either way.
    const left = Math.min(Math.max(GAP, b.right + GAP - width), window.innerWidth - width - GAP);
    const below = window.innerHeight - b.bottom - GAP * 2;
    const above = b.top - GAP * 2;
    setPlace(
      below >= 160 || below >= above
        ? { left, width, top: b.bottom + GAP, maxHeight: below }
        : { left, width, bottom: window.innerHeight - b.top + GAP, maxHeight: above }
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Fixed to the screen, it would stay behind as its card scrolled away.
    const gone = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    document.addEventListener("scroll", gone, true);
    window.addEventListener("resize", gone);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      document.removeEventListener("scroll", gone, true);
      window.removeEventListener("resize", gone);
    };
  }, [open]);

  return (
    <span ref={ref} className="inline-flex">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setPlace(null);
          setOpen((o) => !o);
        }}
        className="-m-1 rounded-full p-1 text-fg-faint transition-colors hover:text-fg focus-visible:text-fg"
      >
        <Info aria-hidden size={13} strokeWidth={1.75} />
      </button>
      {open && place && (
        <div
          id={id}
          role="note"
          style={{
            left: place.left,
            width: place.width,
            top: place.top,
            bottom: place.bottom,
            maxHeight: place.maxHeight,
          }}
          className="pop thin-scroll fixed z-50 overflow-y-auto rounded-card bg-surface p-3 text-xs leading-relaxed text-fg-muted shadow-popover"
        >
          <div className="font-medium text-fg">{title}</div>
          <ul className="mt-1 space-y-1">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
