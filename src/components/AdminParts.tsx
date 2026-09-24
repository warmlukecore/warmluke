// What the two admin screens, accounts and demo requests, both show:
// a number with a line under it, a count broken down as bars, and a
// link somebody typed made safe to follow.
//
// Callers: src/app/admin/page.tsx, src/app/admin/demos/page.tsx.

import { card } from "@/components/ui/controls";

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
