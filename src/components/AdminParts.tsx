// What the admin screens share: the stages a demo request moves through,
// a number with a line under it, a count broken down as bars, a link
// somebody typed made safe to follow, a row of choices, and a list that
// keeps its size (ListPanel: a search, a count, its own scroller).
//
// Callers: src/app/[gate]/page.tsx, src/app/[gate]/demos/page.tsx,
// src/app/[gate]/invites/page.tsx, and the privacy, access and spend screens.

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { button, card, field } from "@/components/ui/controls";
import type { Option } from "@/lib/onboarding";

/**
 * Where a demo request stands, in order. The values are 0120's check on
 * demo_followups.stage, word for word (check-follow-up compares them).
 */
export const DEMO_STAGES: Option[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "scheduled", label: "Call booked" },
  { value: "customer", label: "Customer" },
  { value: "not_a_fit", label: "Not a fit" },
];

/** Each stage's badge. */
export const STAGE_TONE: Record<string, string> = {
  new: "bg-tone-info text-tone-info-fg",
  contacted: "bg-tone-attention text-tone-attention-fg",
  scheduled: "bg-tone-warning text-tone-warning-fg",
  customer: "bg-tone-success text-tone-success-fg",
  not_a_fit: "bg-tone-neutral text-tone-neutral-fg",
};

export function Stat({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className={`${card} p-4`}>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">{value.toLocaleString()}</span>
        <span className="text-xs text-fg-faint">{sub}</span>
      </div>
    </div>
  );
}

/** The most common answers, as bars against the most common one. */
export function Breakdown({ label, counts, empty }: { label: string; counts: Array<[string, number]>; empty: string }) {
  return (
    <div className={`${card} p-4`}>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      {counts.length === 0 ? (
        <div className="mt-2 text-[13px] text-fg-faint">{empty}</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {counts.map(([k, n]) => (
            <li key={k} className="flex items-center gap-2 text-xs">
              <span className="w-32 truncate text-fg" title={k}>
                {k}
              </span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.round((n / Math.max(1, counts[0][1])) * 100)}%` }}
                />
              </span>
              <span className="w-5 text-right text-fg-muted tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Counts of each label, most common first, the top four. */
export function topCounts(labels: Array<string | null | undefined>): Array<[string, number]> {
  const seen = new Map<string, number>();
  for (const l of labels) if (l) seen.set(l, (seen.get(l) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
}

/** A link somebody typed, made safe to follow: https only, shown bare. */
export function siteLink(raw: string | null | undefined): { href: string; text: string } | null {
  if (!raw) return null;
  const text = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  try {
    const u = new URL(`https://${text}`);
    return u.hostname.includes(".") ? { href: u.toString(), text } : null;
  } catch {
    return null;
  }
}

/** A row of choices, one of them picked. */
export function Choices<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Array<[T, string]>;
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`rounded-control border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50 ${
            value === v
              ? "border-primary bg-surface-hover font-medium text-fg"
              : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** What a console screen says when its function refused or is missing from this database. */
export function adminError(e: { code?: string; message: string }, migration: string): string {
  if (e.code === "42501") return "This page is for administrators.";
  if (e.code === "PGRST202") return `This database does not have this screen yet: apply migration ${migration}.`;
  return e.message;
}

/** A table's header row, held at the top of its ListPanel as the rows scroll under it. */
export const stickyHead = "sticky top-0 z-[1] border-b border-line bg-surface-subdued";

/** A console list's card: it scrolls in place past a screenful rather than stretching the page. */
export const panelScroll = "thin-scroll max-h-[min(70vh,44rem)] overflow-auto";

/** A list inside a card of its own that scrolls in place past a screenful, rather than stretching the page. */
export const scrollList = "thin-scroll max-h-[min(60vh,30rem)] overflow-y-auto";

/** Whether any of a row's words holds what was typed, case aside. */
export const matches = (q: string, ...words: Array<string | null | undefined>) => {
  const w = q.trim().toLowerCase();
  return !w || words.some((x) => (x ?? "").toLowerCase().includes(w));
};

/** The console's search box: an icon, the words, Escape to clear. */
export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
}) {
  return (
    <label className="relative block w-full max-w-xs">
      <Search
        aria-hidden
        size={15}
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${field} pl-8`}
      />
    </label>
  );
}

/**
 * A console list that keeps its size: a search over it, how many show of
 * how many, and the rows in a card that scrolls in place past a screenful,
 * so a long list does not stretch the page (a table puts `stickyHead` on
 * its header row). When the server sends it in pages, `more` asks for the
 * next one.
 */
export function ListPanel({
  query,
  onQuery,
  placeholder = "Find",
  shown,
  total,
  noun,
  actions,
  more,
  children,
}: {
  query?: string;
  onQuery?: (q: string) => void;
  placeholder?: string;
  shown: number;
  /** All there are, when known; a paged list without a count leaves it out. */
  total?: number;
  /** What a row is, for the count: "accounts". */
  noun: string;
  actions?: ReactNode;
  more?: { onMore: () => void; busy?: boolean } | null;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {onQuery ? <SearchBox value={query ?? ""} onChange={onQuery} placeholder={placeholder} /> : <span />}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-fg-faint tabular-nums" aria-live="polite">
            {total === undefined || shown === total
              ? `${shown.toLocaleString()} ${noun}`
              : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
          </span>
          {actions}
        </div>
      </div>
      <div className={`${card} ${panelScroll} relative mt-3`}>{children}</div>
      {more && (
        <div className="mt-3 flex justify-center">
          <button onClick={more.onMore} disabled={more.busy} className={button("secondary", "sm")}>
            {more.busy ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
