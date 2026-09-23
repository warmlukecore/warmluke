// ─────────────────────────────────────────────────────────────
// What a badge means, and how it says so.
//
// Colour on a page is for meaning. A store's own statuses have one —
// payment pending needs the merchant, paid does not — so each is given
// its label and tone here, once, from Shopify's own fixed lists. What a
// merchant's own sections hold (a category, a size, a person) means
// nothing we know of, so it gets a calm colour of its own and never a
// tone that would say "attention" or "failed" about it.
//
// No imports, so the checks run it as the page does.
// ─────────────────────────────────────────────────────────────

export type Tone = "attention" | "warning" | "success" | "info" | "critical" | "neutral";
/** Unfinished work shows a hollow circle, finished a filled one. */
export type Progress = "incomplete" | "partial" | "complete";

type Known = { label: string; tone: Tone; progress: Progress };

/**
 * Shopify's order statuses — displayFinancialStatus and
 * displayFulfillmentStatus — plus the one the orders view adds for a
 * cancelled order. Their values are Shopify's, not ours; how each reads
 * follows how a merchant's commerce admin shows it.
 */
const KNOWN: Record<string, Known> = {
  // Payment
  PENDING: { label: "Payment pending", tone: "attention", progress: "incomplete" },
  AUTHORIZED: { label: "Authorized", tone: "attention", progress: "incomplete" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "warning", progress: "partial" },
  PAID: { label: "Paid", tone: "neutral", progress: "complete" },
  PARTIALLY_REFUNDED: { label: "Partially refunded", tone: "neutral", progress: "partial" },
  REFUNDED: { label: "Refunded", tone: "neutral", progress: "complete" },
  VOIDED: { label: "Voided", tone: "neutral", progress: "complete" },
  EXPIRED: { label: "Expired", tone: "critical", progress: "incomplete" },
  // Fulfilment
  UNFULFILLED: { label: "Unfulfilled", tone: "warning", progress: "incomplete" },
  PARTIALLY_FULFILLED: { label: "Partially fulfilled", tone: "warning", progress: "partial" },
  IN_PROGRESS: { label: "In progress", tone: "info", progress: "partial" },
  PENDING_FULFILLMENT: { label: "Pending", tone: "attention", progress: "incomplete" },
  OPEN: { label: "Open", tone: "info", progress: "incomplete" },
  SCHEDULED: { label: "Scheduled", tone: "info", progress: "incomplete" },
  ON_HOLD: { label: "On hold", tone: "warning", progress: "incomplete" },
  REQUEST_DECLINED: { label: "Request declined", tone: "critical", progress: "incomplete" },
  FULFILLED: { label: "Fulfilled", tone: "neutral", progress: "complete" },
  RESTOCKED: { label: "Restocked", tone: "neutral", progress: "complete" },
  // The orders view says this for a cancelled order, whatever it was paid.
  CANCELLED: { label: "Cancelled", tone: "neutral", progress: "complete" },
};

const key = (value: string) => value.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** A store status we know the meaning of, or null. */
export function knownStatus(value: string): Known | null {
  return KNOWN[key(value)] ?? null;
}

/** What a badge should say: the status's own words, or the value itself. */
export function badgeLabel(value: string): string {
  return knownStatus(value)?.label ?? value;
}

/** The token classes for each tone — drawn from globals.css, never a raw colour. */
export const TONE_CLASSES: Record<Tone, string> = {
  attention: "bg-tone-attention text-tone-attention-fg",
  warning: "bg-tone-warning text-tone-warning-fg",
  success: "bg-tone-success text-tone-success-fg",
  info: "bg-tone-info text-tone-info-fg",
  critical: "bg-tone-critical text-tone-critical-fg",
  neutral: "bg-tone-neutral text-tone-neutral-fg",
};

/**
 * Calm colours for values with no known meaning, chosen by the value so
 * the same word always looks the same. None of them is a tone: nothing
 * here may read as "needs attention" or "failed" about a category.
 */
const QUIET = [
  "bg-sky-100 text-sky-900",
  "bg-violet-100 text-violet-900",
  "bg-teal-100 text-teal-900",
  "bg-indigo-100 text-indigo-900",
  "bg-lime-100 text-lime-900",
  "bg-fuchsia-100 text-fuchsia-900",
  "bg-cyan-100 text-cyan-900",
  "bg-stone-200 text-stone-800",
];

/** The classes a badge for this value is drawn with. */
export function badgeClasses(value: string): string {
  const known = knownStatus(value);
  if (known) return TONE_CLASSES[known.tone];
  const k = value.trim().toLowerCase();
  if (!k) return TONE_CLASSES.neutral;
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  return QUIET[Math.abs(hash) % QUIET.length];
}
