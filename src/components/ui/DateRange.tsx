"use client";

// The dates a list is read over: one button saying which, opening the
// shortcuts beside a calendar of two months (one, as a sheet, on a
// phone). A shortcut applies at once; days of their own apply with Apply.
// Every pick is days in the store's zone (lib/period): the calendar shows
// them, it does not decide them.
//
// The calendar grid is react-day-picker's, for its keyboard and screen
// reader work, drawn with the app's tokens; the button, the shortcuts
// and the popover are ours. It replaced chips and two of the browser's
// own date boxes (Tanish, 3 Oct).

import { useEffect, useId, useRef, useState } from "react";
import { DayPicker, type DateRange as Days } from "react-day-picker";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { NAMED, type Named, type PeriodPick } from "@/lib/period";
import { button, menu, menuItem } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/Dialog";

/** A YYYY-MM-DD day as the calendar's Date, at local midnight, and back. */
const asDate = (day: string) =>
  new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const asDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Shortcut = { key: string; label: string; pick: PeriodPick };

export function DateRange({
  label,
  pick,
  shown,
  today,
  presets,
  locale,
  weekStart,
  onPick,
}: {
  /** The field the dates are of, as the section says it: "Shipped". */
  label: string;
  pick: PeriodPick;
  /** The pick as two days, worked out (null for every row). */
  shown: { fromDay: string; toDay: string } | null;
  /** Today where the store is, YYYY-MM-DD. */
  today: string;
  /** The windows of days the section offers, beside Today. */
  presets: number[];
  locale: string;
  /** 0 Sunday … 6 Saturday. */
  weekStart: number;
  onPick: (pick: PeriodPick) => void;
}) {
  const [open, setOpen] = useState<"pop" | "sheet" | null>(null);
  const [fromRight, setFromRight] = useState(false);
  const [draft, setDraft] = useState<Days | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  const shortcuts: Shortcut[] = [
    { key: "1", label: "Today", pick: { days: 1 } },
    { key: "yesterday", label: NAMED.yesterday, pick: { named: "yesterday" } },
    ...presets
      .filter((n) => n > 1)
      .map((n) => ({ key: String(n), label: `Last ${n} days`, pick: { days: n } as PeriodPick })),
    ...(["this_week", "last_week", "this_month", "last_month", "this_year"] as Named[]).map((n) => ({
      key: n,
      label: NAMED[n],
      pick: { named: n } as PeriodPick,
    })),
    { key: "all", label: "All time", pick: null },
  ];
  const keyOf = (p: PeriodPick) => (!p ? "all" : "days" in p ? String(p.days) : "named" in p ? p.named : "own");
  const current = keyOf(pick);

  const day = (d: string, year: boolean) =>
    asDate(d).toLocaleDateString(locale, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
  const words = (r: { fromDay: string; toDay: string } | null) =>
    !r
      ? "All time"
      : r.fromDay === r.toDay
        ? day(r.fromDay, true)
        : `${day(r.fromDay, r.fromDay.slice(0, 4) !== r.toDay.slice(0, 4))} – ${day(r.toDay, true)}`;

  useEffect(() => {
    if (open !== "pop") return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const show = () => {
    setDraft(shown ? { from: asDate(shown.fromDay), to: asDate(shown.toDay) } : undefined);
    // A phone gets the sheet; a desk the popover, towards the space there is.
    const narrow = window.matchMedia("(max-width: 639px)").matches;
    const at = trigger.current?.getBoundingClientRect();
    setFromRight(!!at && at.left + 720 > window.innerWidth - 8);
    setOpen(narrow ? "sheet" : "pop");
  };
  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  const choose = (p: PeriodPick) => {
    onPick(p);
    close();
  };
  const ownDays = draft?.from && draft?.to ? { fromDay: asDay(draft.from), toDay: asDay(draft.to) } : null;
  const apply = () => ownDays && choose({ from: ownDays.fromDay, to: ownDays.toDay });

  const months = open === "sheet" ? 1 : 2;
  const end = asDate(today);
  const calendar = (
    <DayPicker
      mode="range"
      selected={draft}
      onSelect={setDraft}
      numberOfMonths={months}
      // The last month shown is the one the range ends in, or this one.
      defaultMonth={(() => {
        const last = draft?.to ?? draft?.from ?? end;
        return new Date(last.getFullYear(), last.getMonth() - (months - 1), 1);
      })()}
      endMonth={end}
      today={end}
      disabled={{ after: end }}
      weekStartsOn={weekStart as 0 | 1 | 2 | 3 | 4 | 5 | 6}
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
        months: "flex flex-wrap gap-6",
        month: "space-y-2",
        month_caption: "flex h-8 items-center justify-center font-medium",
        caption_label: "text-[13px]",
        nav: "absolute inset-x-0 top-0 flex h-8 items-center justify-between",
        button_previous:
          "inline-flex h-8 w-8 items-center justify-center rounded-control text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus",
        button_next:
          "inline-flex h-8 w-8 items-center justify-center rounded-control text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus",
        month_grid: "border-collapse",
        weekday: "h-8 w-9 text-center text-[11px] font-medium text-fg-muted",
        day: "h-9 w-9 p-0 text-center",
        day_button:
          "h-9 w-9 rounded-control tabular-nums transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed",
        selected: "",
        range_middle: "bg-surface-subdued [&>button]:rounded-none [&>button]:hover:bg-surface-hover",
        range_start: "[&>button]:bg-primary [&>button]:text-on-primary [&>button]:hover:bg-primary-hover",
        range_end: "[&>button]:bg-primary [&>button]:text-on-primary [&>button]:hover:bg-primary-hover",
        today: "[&>button]:font-semibold [&>button]:underline [&>button]:underline-offset-4",
        disabled: "text-fg-faint",
        outside: "text-fg-faint",
      }}
    />
  );
  const list = (
    <ul aria-label="Shortcuts" className={open === "sheet" ? "grid grid-cols-2 gap-x-2" : "flex flex-col"}>
      {shortcuts.map((s) => (
        <li key={s.key}>
          <button
            type="button"
            aria-pressed={s.key === current}
            onClick={() => choose(s.pick)}
            className={`${menuItem} ${s.key === current ? "font-medium text-fg" : "text-fg-muted"}`}
          >
            {s.label}
          </button>
        </li>
      ))}
    </ul>
  );
  const foot = (
    <>
      <span className="mr-auto truncate text-xs text-fg-muted" aria-live="polite">
        {ownDays ? words(ownDays) : "Pick a first and a last day"}
      </span>
      <button type="button" onClick={close} className={button("plain", "sm")}>
        Cancel
      </button>
      <button type="button" onClick={apply} disabled={!ownDays} className={button("primary", "sm")}>
        Apply
      </button>
    </>
  );

  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open === "pop" ? `${id}-pop` : undefined}
        aria-label={`${label}: ${words(shown)}`}
        onClick={() => (open ? close() : show())}
        className={button("secondary", "sm")}
      >
        <CalendarDays aria-hidden size={14} strokeWidth={1.75} className="text-fg-muted" />
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums">{words(shown)}</span>
        <ChevronDown aria-hidden size={13} strokeWidth={2} className="text-fg-faint" />
      </button>
      {open === "pop" && (
        <div
          id={`${id}-pop`}
          role="dialog"
          aria-label={`${label} dates`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          // w-max: positioned in the button's own small box, it would shrink to it and stack the months.
          className={`${menu} absolute top-full mt-1 flex w-max max-w-[calc(100vw-2rem)] flex-col p-0 ${fromRight ? "right-0" : "left-0"}`}
        >
          <div className="flex">
            <div className="w-40 shrink-0 border-r border-line p-1">{list}</div>
            <div className="p-3">{calendar}</div>
          </div>
          <div className="flex items-center gap-2 border-t border-line bg-surface-subdued px-3 py-2">{foot}</div>
        </div>
      )}
      {open === "sheet" && (
        <Dialog title={`${label} dates`} onClose={close} footer={foot}>
          <div className="space-y-4">
            {list}
            <div className="flex justify-center border-t border-line pt-3">{calendar}</div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
