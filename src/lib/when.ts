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
