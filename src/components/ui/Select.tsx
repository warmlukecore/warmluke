"use client";

// A choice drawn as the app draws one, never the computer's own grey menu
// (a row's status, a link to another section's row). A button saying what
// is chosen, and a list: the arrows move, Enter or Space picks, Escape
// closes, a letter jumps to the next option starting with it. Opens up
// when there is no room below, as in a dialog's last field.
//
// Callers: src/components/RecordModal.tsx (and placeBy: ui/DateField.tsx).

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { field, menu, menuItem } from "@/components/ui/controls";

export type SelectOption = { value: string; label: string };

/**
 * Where a list or a month opens: under its button, or over it when the
 * screen has no room below. Fixed to the screen, so the scrolling body of
 * a dialog cannot cut it off (a row's calendar lost its last week, 3 Oct).
 */
export function placeBy(button: HTMLElement | null, height: number): CSSProperties {
  const at = button?.getBoundingClientRect();
  if (!at) return {};
  const below = window.innerHeight - at.bottom;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 8 - Math.max(at.width, 280)));
  return below < height + 8 && at.top > below
    ? { position: "fixed", left, minWidth: at.width, bottom: window.innerHeight - at.top + 4 }
    : { position: "fixed", left, minWidth: at.width, top: at.bottom + 4 };
}

/** While open: a click elsewhere, or the page under it scrolling or resizing, closes it. */
export function useCloseAway(open: boolean, box: { current: HTMLElement | null }, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const resized = () => setOpen(false);
    document.addEventListener("mousedown", away);
    // Its own list scrolling is not the page moving under it.
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", resized);
    };
  }, [open, box, setOpen]);
}

export function Select({
  value,
  options,
  onChange,
  label,
  empty = "—",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** What the field is, for a screen reader: the form's own label. */
  label: string;
  /** Shown when nothing is chosen, and offered first to clear it. */
  empty?: string;
}) {
  const all = [{ value: "", label: empty }, ...options];
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = all.find((o) => o.value === value);

  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);
  useCloseAway(open, box, setOpen);
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setPlace(placeBy(trigger.current, 232));
    setActive(
      Math.max(
        0,
        all.findIndex((o) => o.value === value)
      )
    );
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(all[i].value);
    setOpen(false);
    trigger.current?.focus();
  };
  const keys = (e: KeyboardEvent) => {
    const last = all.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") {
      // The dialog around it stays open: only the list closes.
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "Tab") return setOpen(false);
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const next = all
        .map((_, j) => (active + 1 + j) % all.length)
        .find((j) => all[j].label.toLowerCase().startsWith(k));
      if (next === undefined) return;
      setActive(next);
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${chosen?.value ? chosen.label : "none"}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
        className={`${field} flex cursor-pointer items-center justify-between gap-2 text-left`}
      >
        <span className={`truncate ${chosen?.value ? "" : "text-fg-faint"}`}>{chosen?.label ?? value}</span>
        <ChevronDown aria-hidden size={14} strokeWidth={2} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className={menu} style={{ ...place, width: place.minWidth }}>
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={`${id}-${active}`}
            onKeyDown={keys}
            className="max-h-56 overflow-y-auto outline-none thin-scroll"
          >
            {all.map((o, i) => (
              <li
                key={o.value || "none"}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                onClick={() => choose(i)}
                onMouseEnter={() => setActive(i)}
                className={`${menuItem} cursor-pointer ${i === active ? "bg-surface-hover" : ""} ${o.value ? "" : "text-fg-muted"}`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && (
                  <Check aria-hidden size={14} strokeWidth={2} className="shrink-0 text-fg-muted" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
