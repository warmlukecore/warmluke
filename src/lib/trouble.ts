// The kinds of sign the radar keeps (0175, 0211), as the console names
// them: one place, so Needs a look and yesterday's card say the same.
//
// Callers: src/app/[gate]/trouble/page.tsx, src/components/TroubleDay.tsx.

export type TroubleKind =
  | "turn"
  | "frustrated"
  | "cant"
  | "gap"
  | "slow"
  | "rebuilds"
  | "churn"
  | "rule"
  | "idle"
  | "cut"
  | "screen"
  | "workaround"
  | "left";

/** Its chip: a short name and its tone. */
export const TROUBLE_KIND: Record<TroubleKind, [string, string]> = {
  turn: ["Luke", "bg-tone-critical text-tone-critical-fg"],
  frustrated: ["Owner", "bg-tone-attention text-tone-attention-fg"],
  cant: ["Can't", "bg-tone-warning text-tone-warning-fg"],
  gap: ["Not done", "bg-tone-warning text-tone-warning-fg"],
  slow: ["Slow", "bg-tone-info text-tone-info-fg"],
  rebuilds: ["Rebuilds", "bg-tone-attention text-tone-attention-fg"],
  churn: ["Section", "bg-tone-info text-tone-info-fg"],
  rule: ["Rule", "bg-tone-critical text-tone-critical-fg"],
  idle: ["Rule idle", "bg-tone-warning text-tone-warning-fg"],
  cut: ["Cut short", "bg-tone-warning text-tone-warning-fg"],
  screen: ["Screen", "bg-tone-attention text-tone-attention-fg"],
  workaround: ["Design", "bg-tone-warning text-tone-warning-fg"],
  left: ["Left", "bg-tone-neutral text-tone-neutral-fg"],
};

export const troubleName = (k: string) => TROUBLE_KIND[k as TroubleKind]?.[0] ?? k;
export const troubleTone = (k: string) => TROUBLE_KIND[k as TroubleKind]?.[1] ?? "bg-tone-neutral text-tone-neutral-fg";

/** Where a sign points: its turn in the conversation when it has one, else the conversation. */
export const troubleHref = (gate: string, conversation: string, turn?: string | null) =>
  `/${gate}/conversations?id=${conversation}${turn ? `#turn-${turn}` : ""}`;
