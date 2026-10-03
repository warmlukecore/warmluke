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
  // Products
  ACTIVE: { label: "Active", tone: "success", progress: "complete" },
  DRAFT: { label: "Draft", tone: "info", progress: "incomplete" },
  ARCHIVED: { label: "Archived", tone: "neutral", progress: "complete" },
  // The orders view says this for a cancelled order, whatever it was paid.
  CANCELLED: { label: "Cancelled", tone: "neutral", progress: "complete" },
  // Shipments: a fulfilment's displayStatus, as the courier reports it.
  LABEL_PRINTED: { label: "Label printed", tone: "info", progress: "partial" },
  LABEL_PURCHASED: { label: "Label purchased", tone: "info", progress: "partial" },
  LABEL_VOIDED: { label: "Label voided", tone: "neutral", progress: "complete" },
  SUBMITTED: { label: "Submitted", tone: "info", progress: "incomplete" },
  CONFIRMED: { label: "Confirmed", tone: "info", progress: "partial" },
  CARRIER_PICKED_UP: { label: "With the courier", tone: "info", progress: "partial" },
  IN_TRANSIT: { label: "In transit", tone: "info", progress: "partial" },
  OUT_FOR_DELIVERY: { label: "Out for delivery", tone: "info", progress: "partial" },
  READY_FOR_PICKUP: { label: "Ready for pickup", tone: "info", progress: "partial" },
  DELAYED: { label: "Delayed", tone: "warning", progress: "incomplete" },
  ATTEMPTED_DELIVERY: { label: "Delivery attempted", tone: "attention", progress: "incomplete" },
  NOT_DELIVERED: { label: "Not delivered", tone: "critical", progress: "incomplete" },
  FAILURE: { label: "Failed", tone: "critical", progress: "incomplete" },
  DELIVERED: { label: "Delivered", tone: "neutral", progress: "complete" },
  PICKED_UP: { label: "Picked up", tone: "neutral", progress: "complete" },
  MARKED_AS_FULFILLED: { label: "Marked as fulfilled", tone: "neutral", progress: "complete" },
  CANCELED: { label: "Cancelled", tone: "neutral", progress: "complete" },
  // Transactions
  SUCCESS: { label: "Successful", tone: "neutral", progress: "complete" },
  ERROR: { label: "Error", tone: "critical", progress: "incomplete" },
  AWAITING_RESPONSE: { label: "Awaiting response", tone: "attention", progress: "incomplete" },
  // Draft orders and returns
  INVOICE_SENT: { label: "Invoice sent", tone: "attention", progress: "incomplete" },
  COMPLETED: { label: "Completed", tone: "neutral", progress: "complete" },
  REQUESTED: { label: "Requested", tone: "attention", progress: "incomplete" },
  DECLINED: { label: "Declined", tone: "neutral", progress: "complete" },
  CLOSED: { label: "Closed", tone: "neutral", progress: "complete" },
};

/**
 * How Shopify writes a status: capitals joined by underscores. A
 * merchant's own words never look like that, which is what keeps the
 * "Pending" in their repairs section from being read as "Payment
 * pending" — the same word, meaning something else entirely.
 */
const SHOPIFY_FORM = /^[A-Z]+(?:_[A-Z]+)*$/;

/** Each known store status in words, for a written screen's wl.label (custom-view.ts). */
export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(KNOWN).map(([k, v]) => [k, v.label])
);

/** A store status we know the meaning of, or null. */
export function knownStatus(value: string): Known | null {
  const v = value.trim();
  return SHOPIFY_FORM.test(v) ? (KNOWN[v] ?? null) : null;
}

/**
 * A status with nothing left in it for the merchant: finished, and quiet
 * (Paid, Fulfilled, Delivered). A row whose statuses are all settled is
 * drawn muted, so what still needs them stands out. Active is finished
 * but not quiet: an active product is the norm, not old news.
 */
export function isSettled(value: string): boolean {
  const k = knownStatus(value);
  return !!k && k.progress === "complete" && k.tone === "neutral";
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
// Each with its night pair: these are the app's only raw colours, so the
// dark theme's tokens do not reach them (check-theme holds them to it).
const QUIET = [
  "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  "bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200",
  "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200",
  "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200",
];

/** One of the calm colours, the same one every time for the same word. */
export function quietClasses(value: string): string {
  const k = value.trim().toLowerCase();
  if (!k) return TONE_CLASSES.neutral;
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  return QUIET[Math.abs(hash) % QUIET.length];
}

/** The classes a badge for this value is drawn with. */
export function badgeClasses(value: string): string {
  const known = knownStatus(value);
  return known ? TONE_CLASSES[known.tone] : quietClasses(value);
}
