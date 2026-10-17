// ─────────────────────────────────────────────────────────────
// What comes after an alert (16 Oct, the sprint's Days 12–13): the next
// step in a line, whose job it is by the team's own answers, and what
// Luke found looking into RTO. No model is asked: the step is the kind's,
// the person is the owner's own answer, the finding is counted in the
// database (abo_rto_cohorts, 0225). Kept apart from lib/alerts (its
// icons) so the server and Luke's turn read it without the screen's code.
//
// Callers: src/components/Alerts.tsx, src/components/AppShell.tsx,
// src/lib/app-actions.ts (whats_waiting), scripts/check-alert-next.mjs.
// ─────────────────────────────────────────────────────────────

type Role = "packing" | "customers" | "ads" | "restocking";
type Step = { next: (facts: Record<string, unknown>) => string; handledBy: Role };

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Each kind's next step, never something Luke does on his own, and whose job it usually is. */
const STEPS: Record<string, Step> = {
  low_stock: {
    next: (f) =>
      Number(f.lead_days) > 0
        ? `Reorder now: a restock takes ${days(Number(f.lead_days))}`
        : "Reorder it, and say how long a restock takes in Settings so Luke can tell you when",
    handledBy: "restocking",
  },
  dispatch_late: {
    next: () => "Send the oldest first, or tell those customers when theirs will go",
    handledBy: "packing",
  },
  returns_spike: {
    next: () => "Read this week's returns for a reason they share, and check the batch before more ship",
    handledBy: "customers",
  },
  return_reason: { next: () => "Check the product page and the stock behind this reason", handledBy: "customers" },
  rto_rising: {
    next: () => "Start with the worst courier and area, and confirm COD orders before they ship",
    handledBy: "packing",
  },
  ads_no_sales: {
    next: () => "Check the campaign's link, its tagging and the stock it sends to; its budget is yours to change",
    handledBy: "ads",
  },
  ads_low_stock: {
    next: (f) =>
      `Reorder what it sells${Number(f.lead_days) > 0 ? ` (a restock takes ${days(Number(f.lead_days))})` : ""}, or move its spend to what is in stock; its budget is yours to change`,
    handledBy: "ads",
  },
};

/** The next step for an alert, or null when its kind has none. */
export function nextOf(a: { kind: string; facts?: Record<string, unknown> | null }): string | null {
  return STEPS[a.kind]?.next(a.facts ?? {}) ?? null;
}

/** Who handles it, from the team's own answers (lib/team-facts loadTeam): "Ravi handles this", or "Yours to handle". */
export function whoOf(kind: string, team: Partial<Record<Role, string>> | null): string | null {
  const role = STEPS[kind]?.handledBy;
  const said = role ? team?.[role]?.trim() : "";
  if (!said) return null;
  return /^(me|myself|i)$/i.test(said) ? "Yours to handle" : `${said} handles this`;
}

type Cohort = { name: string; rto: number; settled: number; rate: number | null; change: number | null };

/**
 * What Luke found looking into an alert, as its watch recorded it when it
 * noticed (0230: RTO by payment and by state, kept in its facts); null for
 * a kind whose facts are already its evidence, or one recorded before 0230.
 */
export function foundOf(a: { kind: string; facts?: Record<string, unknown> | null }): string | null {
  const f = a.facts ?? {};
  if (a.kind !== "rto_rising" || !f.by_payment) return null;
  return lookedIntoRto(f.by_payment as { groups?: Cohort[] }, f.by_state as { groups?: Cohort[] } | null);
}

/**
 * What Luke found looking into RTO (abo_rto_cohorts, 0225), in a line: the
 * groups by payment and by state with the most coming back, each with its
 * counts and how much it moved. Only groups with enough settled shipments.
 */
export function lookedIntoRto(...breakdowns: Array<{ groups?: Cohort[] } | null>): string {
  const groups = breakdowns
    .flatMap((b) => b?.groups ?? [])
    .filter((g) => g.rate !== null && !/^Unknown|^No NDR/.test(g.name))
    .toSorted((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
    .slice(0, 3);
  if (!groups.length) return "Luke looked into it: too few shipments settled yet to say where.";
  return `Luke looked into it: ${groups
    .map(
      (g) =>
        `${g.name} ${g.rate}% (${g.rto} of ${g.settled})${
          g.change
            ? `, ${g.change > 0 ? "up" : "down"} ${Math.abs(g.change)} point${Math.abs(g.change) === 1 ? "" : "s"}`
            : ""
        }`
    )
    .join(" · ")}`;
}
