// ─────────────────────────────────────────────────────────────
// Onboarding: what it asks, and where a person is in it.
//
// The lists are the ones supabase/migrations/0112 holds the answers
// to — check-onboarding compares them, so a value added here and not
// there fails before it can fail at save time.
//
// Where someone is comes from what is true, not from a step number the
// page kept: answers saved, a store connected, an assistant set up. A
// person who leaves halfway comes back to the first thing still missing.
//
// No imports, so the checks run it as the page does.
// ─────────────────────────────────────────────────────────────

export type Option = { value: string; label: string };

export const ROLE_OPTIONS: Option[] = [
  { value: "founder", label: "Founder / owner" },
  { value: "operations", label: "Operations" },
  { value: "ecommerce", label: "Ecommerce" },
  { value: "customer_experience", label: "Customer experience" },
  { value: "technology", label: "Technology" },
  { value: "finance", label: "Finance" },
  { value: "other", label: "Other" },
];

export const ORDER_OPTIONS: Option[] = [
  { value: "under_500", label: "Under 500" },
  { value: "500_2000", label: "500–2,000" },
  { value: "2001_5000", label: "2,001–5,000" },
  { value: "5001_10000", label: "5,001–10,000" },
  { value: "10001_25000", label: "10,001–25,000" },
  { value: "above_25000", label: "More than 25,000" },
  { value: "undisclosed", label: "Prefer not to say" },
];

export const PLATFORM_OPTIONS: Option[] = [
  { value: "shopify", label: "Shopify" },
  { value: "shopify_plus", label: "Shopify Plus" },
  { value: "woocommerce", label: "WooCommerce" },
  { value: "magento", label: "Magento / Adobe Commerce" },
  { value: "custom", label: "Custom platform" },
  { value: "multiple", label: "Multiple platforms" },
  { value: "other", label: "Other" },
];

export const TEAM_OPTIONS: Option[] = [
  { value: "just_me", label: "Just me" },
  { value: "2_5", label: "2–5" },
  { value: "6_20", label: "6–20" },
  { value: "21_50", label: "21–50" },
  { value: "51_200", label: "51–200" },
  { value: "above_200", label: "More than 200" },
];

export const HEARD_OPTIONS: Option[] = [
  { value: "referral", label: "Someone told me" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "search", label: "Search" },
  { value: "shopify_app_store", label: "Shopify App Store" },
  { value: "event", label: "An event" },
  { value: "other", label: "Somewhere else" },
];

/** The follow-up a "where did you hear" answer earns, if any. */
export function heardDetailPrompt(heard: string | null | undefined): string | null {
  if (heard === "referral") return "Who told you? (optional)";
  if (heard === "other") return "Where was it? (optional)";
  return null;
}

/** The label for a stored value, or the value itself if the list no longer has it. */
export function labelOf(options: Option[], value: string | null | undefined): string | null {
  if (!value) return null;
  return options.find((o) => o.value === value)?.label ?? value;
}

export type Answers = {
  full_name: string;
  business_name: string;
  role: string;
  monthly_orders: string;
  platform: string;
  website: string;
  team_size: string;
  heard_from: string;
  heard_from_detail: string;
};

export const NAME_MAX = 120;
export const BUSINESS_MAX = 160;
export const TEXT_MAX = 200;

const within = (options: Option[], v: string) => options.some((o) => o.value === v);

/**
 * What is wrong with these answers, field by field; empty when they can
 * be saved. The same limits the table holds them to, said before the
 * database has to refuse them.
 */
export function problems(a: Answers): Partial<Record<keyof Answers, string>> {
  const out: Partial<Record<keyof Answers, string>> = {};
  const name = a.full_name.trim();
  const business = a.business_name.trim();
  if (!name) out.full_name = "Your name, please.";
  else if (name.length > NAME_MAX) out.full_name = `Up to ${NAME_MAX} characters.`;
  if (!business) out.business_name = "What is the business called?";
  else if (business.length > BUSINESS_MAX) out.business_name = `Up to ${BUSINESS_MAX} characters.`;
  if (!within(ROLE_OPTIONS, a.role)) out.role = "Pick the closest one.";
  if (!within(ORDER_OPTIONS, a.monthly_orders)) out.monthly_orders = "Pick a range, or prefer not to say.";
  if (!within(PLATFORM_OPTIONS, a.platform)) out.platform = "Pick where the store runs.";
  if (a.website.trim().length > TEXT_MAX) out.website = `Up to ${TEXT_MAX} characters.`;
  if (a.team_size && !within(TEAM_OPTIONS, a.team_size)) out.team_size = "Pick one of these.";
  if (a.heard_from && !within(HEARD_OPTIONS, a.heard_from)) out.heard_from = "Pick one of these.";
  if (a.heard_from_detail.trim().length > TEXT_MAX) out.heard_from_detail = `Up to ${TEXT_MAX} characters.`;
  return out;
}

/** The row to save: trimmed, and the optional answers left out as null rather than "". */
export function toRow(a: Answers) {
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  return {
    full_name: a.full_name.trim(),
    business_name: a.business_name.trim(),
    role: a.role,
    monthly_orders: a.monthly_orders,
    platform: a.platform,
    website: opt(a.website),
    team_size: opt(a.team_size),
    heard_from: opt(a.heard_from),
    // A follow-up only means something beside the answer that asked for it.
    heard_from_detail: heardDetailPrompt(a.heard_from) ? opt(a.heard_from_detail) : null,
  };
}

/**
 * Set when onboarding sends someone to Shopify, with the time it was
 * set. Shopify returns them to their app; the app sees this and sends
 * them back to finish, if it was set within the hour.
 */
export const RETURN_KEY = "wl_onboarding_return";
export const RETURN_WITHIN_MS = 60 * 60 * 1000;

/** Whether a return note, as stored, still means "send them back". */
export function returnsToOnboarding(stored: string | null, now: number): boolean {
  const at = Number(stored);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < RETURN_WITHIN_MS;
}

export type Step = "about" | "store" | "assistant" | "preparing" | "done";
export const STEPS: Step[] = ["about", "store", "assistant", "preparing", "done"];

export type Signals = {
  /** Their answers are saved. */
  profile: boolean;
  /** A store in one of their own projects is connected. */
  storeConnected: boolean;
  /** They chose to connect one later, this visit. */
  storeSkipped: boolean;
  /** Their own AI is offered to this account at all. */
  assistantOffered: boolean;
  /** It is connected, or they chose later, this visit. */
  assistantDone: boolean;
  /** The connected store's import is still running. */
  importing: boolean;
  /** They chose not to wait for it. */
  preparingSkipped: boolean;
};

/** The first thing still missing, which is where they belong. */
export function currentStep(s: Signals): Step {
  if (!s.profile) return "about";
  if (!s.storeConnected && !s.storeSkipped) return "store";
  if (s.assistantOffered && !s.assistantDone) return "assistant";
  if (s.storeConnected && s.importing && !s.preparingSkipped) return "preparing";
  return "done";
}

/**
 * Whether the dashboard sends this person to onboarding.
 *
 * Anyone who has not finished it — except a person who only works in
 * somebody else's app. They came through an invite to add rows; asking
 * them how many orders their business takes a month would be asking the
 * wrong person the wrong question.
 *
 * Nor Warmluke's own team (an administrator): they are not a business
 * signing up, and their answers would be counted as a customer's. The
 * page is still there to open by hand, to see it as a merchant does.
 */
export function needsOnboarding(a: { onboarded: boolean; ownProjects: number; sharedWithMe: number; staff?: boolean }): boolean {
  if (a.onboarded || a.staff) return false;
  return !(a.ownProjects === 0 && a.sharedWithMe > 0);
}
