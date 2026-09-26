// How long ago something happened, said the way a person would: "just
// now", "5 min ago", "yesterday". One wording for every screen that
// says it — the accounts list, the store's last sync, the overview.
//
// No imports, so the checks run it as the page does.

export function ago(iso: string | null | undefined, now: number, never = "never"): string {
  if (!iso) return never;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return never;
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mo ago` : `${Math.round(months / 12)} y ago`;
}

/** The start of the local day a moment falls in. */
const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/**
 * Which part of a list of past things this falls in: by the calendar,
 * not by hours, so last night at eleven is "Yesterday" at nine today.
 */
export function dayGroup(iso: string, now: number): "Today" | "Yesterday" | "Last 7 days" | "Older" {
  // Rounded, so a day of 23 or 25 hours (a clock change) still counts as one.
  const days = Math.round((day(now) - day(Date.parse(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return days < 7 ? "Last 7 days" : "Older";
}
