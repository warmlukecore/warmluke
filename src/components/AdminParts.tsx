// What the admin screens share: the stages a demo request moves through,
// a number with a line under it, a count broken down as bars, a link
// somebody typed made safe to follow, and a row of choices.
//
// Callers: src/app/admin/page.tsx, src/app/admin/demos/page.tsx,
// src/app/admin/invites/page.tsx.

import { card } from "@/components/ui/controls";
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
export function Breakdown({
  label,
  counts,
  empty,
}: {
  label: string;
  counts: Array<[string, number]>;
  empty: string;
}) {
  return (
    <div className={`${card} p-4`}>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      {counts.length === 0 ? (
        <div className="mt-2 text-[13px] text-fg-faint">{empty}</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {counts.map(([k, n]) => (
            <li key={k} className="flex items-center gap-2 text-xs">
              <span className="w-32 truncate text-fg" title={k}>{k}</span>
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
  const text = raw.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
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
