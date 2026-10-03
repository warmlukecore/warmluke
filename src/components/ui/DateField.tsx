"use client";

// One day, picked as the app draws it: a button saying the day ("2 Oct
// 2026") opening a month (react-day-picker, its keyboard and reader work)
// in place of the browser's own date box. The value is YYYY-MM-DD.
//
// Callers: src/components/RecordModal.tsx.

import { useRef, useState, type CSSProperties } from "react";
import { DayPicker } from "react-day-picker";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { button, field, menu } from "@/components/ui/controls";
import { placeBy, useCloseAway } from "@/components/ui/Select";

const asDate = (day: string) =>
  new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const asDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function DateField({
  value,
  onChange,
  label,
  locale,
}: {
  value: string;
  onChange: (day: string) => void;
  label: string;
  locale: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  // The month it opens on, set when it opens: today is read then, not while drawing.
  const [start, setStart] = useState<Date | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const day = /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
  const shown = day ? asDate(day).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "";

  useCloseAway(open, box, setOpen);

  const show = () => {
    setPlace({ ...placeBy(trigger.current, 360), minWidth: undefined });
    setStart(day ? asDate(day) : new Date());
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${shown || "none"}`}
        onClick={() => (open ? close() : show())}
        className={`${field} flex cursor-pointer items-center justify-between gap-2 text-left`}
      >
        <span className={`tabular-nums ${shown ? "" : "text-fg-faint"}`}>{shown || "Pick a day"}</span>
        <CalendarDays aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // The dialog around it stays open: only the month closes.
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          style={place}
          className={`${menu} w-max p-3`}
        >
          <DayPicker
            mode="single"
            selected={day ? asDate(day) : undefined}
            defaultMonth={start}
            onSelect={(d) => {
              if (d) onChange(asDay(d));
              close();
            }}
            autoFocus
            showOutsideDays={false}
            components={{
              Chevron: ({ orientation }) =>
                orientation === "left" ? (
                  <ChevronLeft aria-hidden size={16} strokeWidth={1.75} />
                ) : (
                  <ChevronRight aria-hidden size={16} strokeWidth={1.75} />
                ),
            }}
            classNames={{
              root: "relative text-[13px] text-fg",
              month_caption: "flex h-8 items-center justify-center font-medium",
              caption_label: "text-[13px]",
              nav: "absolute inset-x-0 top-0 flex h-8 items-center justify-between",
              button_previous:
                "inline-flex h-8 w-8 items-center justify-center rounded-control text-fg-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus",
              button_next:
                "inline-flex h-8 w-8 items-center justify-center rounded-control text-fg-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus",
              month_grid: "border-collapse",
              weekday: "h-8 w-9 text-center text-[11px] font-medium text-fg-muted",
              day: "h-9 w-9 p-0 text-center",
              day_button:
                "h-9 w-9 rounded-control tabular-nums transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
              selected: "[&>button]:bg-primary [&>button]:text-on-primary [&>button]:hover:bg-primary-hover",
              today: "[&>button]:font-semibold [&>button]:underline [&>button]:underline-offset-4",
            }}
          />
          {day && (
            <div className="mt-2 flex justify-end border-t border-line pt-2">
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  close();
                }}
                className={button("plain", "sm")}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
