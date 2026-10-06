"use client";

// A small "i" that opens a few lines saying how something is worked out,
// beside what it explains (a stat's number, first). Opened by a press or
// the keyboard, not by hover alone, so a phone can open it too; closed by
// a second press, Escape, or a press anywhere else. It opens under its
// card and as wide as it (the card is `relative`), so it never runs past
// the screen.
//
// Callers: src/components/GenericRenderer.tsx (stat cards).

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";

export function InfoTip({ label, title, lines }: { label: string; title: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span ref={ref} className="inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-m-1 rounded-full p-1 text-fg-faint transition-colors hover:text-fg focus-visible:text-fg"
      >
        <Info aria-hidden size={13} strokeWidth={1.75} />
      </button>
      {open && (
        <div
          id={id}
          role="note"
          className="pop absolute inset-x-2 top-full z-20 mt-1 rounded-card bg-surface p-3 text-xs leading-relaxed text-fg-muted shadow-popover"
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
