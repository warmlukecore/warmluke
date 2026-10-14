"use client";

// A row of tabs over what they switch between: the settings' panes, a
// section's views. The one open is underlined; the arrow keys move along
// the row, Home and End to its ends, as a tab list does.
//
// Callers: src/components/ProjectSettings.tsx, src/components/GenericRenderer.tsx.

import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type Tab<T extends string> = { id: T; text: ReactNode; count?: number };

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className = "",
}: {
  tabs: Array<Tab<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    onChange(tabs[to].id);
    row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  };
  return (
    // A row wider than the screen scrolls by itself, never its page: the
    // baseline is an inset line so a tab's underline still sits on it.
    <div
      ref={row}
      role="tablist"
      aria-label={label}
      className={`flex gap-4 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:none] ${className}`}
    >
      {tabs.map((t, i) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => move(e, i)}
          className={`shrink-0 border-b-2 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
            value === t.id ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          {t.text}
          {t.count ? (
            <span className="ml-1.5 rounded-full bg-surface-hover px-1.5 text-[11px] text-fg-muted">{t.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
