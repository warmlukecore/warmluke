// The controls every screen is drawn with. A button, a field, a menu
// look the same wherever they appear, so a screen is put together from
// these instead of restyled from scratch — and the look changes here.
// What each is for: docs/design/design-system.md.

export type ButtonTone =
  | "primary"
  | "secondary"
  | "plain"
  | "critical"
  /** A white button whose action destroys something. */
  | "critical-secondary"
  /** A quiet word that turns red as the pointer reaches it. */
  | "critical-plain";
export type ButtonSize = "sm" | "md" | "lg";

const TONES: Record<ButtonTone, string> = {
  primary: "bg-primary text-on-primary shadow-control hover:bg-primary-hover",
  secondary: "bg-surface text-fg shadow-card hover:bg-surface-hover",
  plain: "text-fg-muted hover:bg-surface-hover hover:text-fg",
  critical: "bg-critical text-white shadow-control hover:bg-critical-hover",
  "critical-secondary": "bg-surface text-tone-critical-fg shadow-card hover:bg-tone-critical/30",
  "critical-plain": "text-fg-muted hover:bg-tone-critical/40 hover:text-tone-critical-fg",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1 px-2.5 text-xs",
  md: "h-8 gap-1.5 px-3 text-[13px]",
  lg: "h-10 gap-2 px-4 text-sm",
};

/** Classes for anything that acts as a button — a <button>, a <Link>, an <a>. */
export const button = (tone: ButtonTone = "secondary", size: ButtonSize = "md") =>
  `inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control font-medium transition-[background-color,box-shadow,color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${TONES[tone]} ${SIZES[size]}`;

/** A square button holding one icon. */
const ICON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
export const iconButton = `${ICON} hover:bg-surface-hover hover:text-fg`;
/** The same, for removing something: it turns red under the pointer. */
export const iconButtonCritical = `${ICON} hover:bg-tone-critical/40 hover:text-tone-critical-fg`;

/**
 * Text inputs, selects and text areas: one height, one focus ring, and
 * the error colour whenever aria-invalid is set. Size and width are
 * separate, because two classes for the same property on one element
 * leave the winner to the order of the stylesheet, not the order written.
 */
const FIELD =
  "block rounded-control border border-line-strong bg-surface text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-faint hover:border-fg-faint focus:border-focus focus:ring-3 focus:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-tone-critical-fg aria-[invalid=true]:focus:ring-tone-critical";
const FIELD_SIZES = {
  sm: "px-2 py-1 text-xs leading-4",
  md: "px-3 py-1.5 text-[13px] leading-5",
} as const;

/** A field of this size, with no width: the caller says how wide. */
export const fieldOf = (size: keyof typeof FIELD_SIZES = "md") => `${FIELD} ${FIELD_SIZES[size]}`;

/** The usual field: full width, normal size. */
export const field = `${fieldOf("md")} w-full`;

export const label = "mb-1.5 block text-[13px] font-medium text-fg";
export const hint = "mt-1.5 text-xs leading-relaxed text-fg-muted";

/** A white card on the canvas. */
export const card = "rounded-card bg-surface shadow-card";

/** A menu or popover, and the rows inside one. */
export const menu = "pop z-50 overflow-hidden rounded-card bg-surface p-1 text-[13px] text-fg shadow-popover";
export const menuItem =
  "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none";

/** Notes inside a screen, by what they mean. */
export const note = {
  info: "rounded-control border border-tone-info bg-tone-info/50 px-3 py-2 text-xs leading-relaxed text-tone-info-fg",
  attention:
    "rounded-control border border-tone-attention bg-tone-attention/25 px-3 py-2 text-xs leading-relaxed text-tone-attention-fg",
  critical:
    "rounded-control border border-tone-critical bg-tone-critical/40 px-3 py-2 text-xs leading-relaxed text-tone-critical-fg",
  success:
    "rounded-control border border-tone-success bg-tone-success/30 px-3 py-2 text-xs leading-relaxed text-tone-success-fg",
} as const;
