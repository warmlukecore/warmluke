// What of their website was read, and what was not (0228), in words for
// Luke and Settings. Kept apart from lib/site-read, which reads the web
// with node's own modules, so Luke's turn reads this without them.
//
// Callers: src/lib/engine.ts, src/lib/site-read.ts, src/components/SiteFacts.tsx.

/** How a page went: read, not there, or turned away / not answering / not public. */
export type PageWhy = "not found" | "could not be read";

/** Each page as it went, one word each, for Settings and for Luke (0228). */
export type Coverage = Record<"home" | "refund" | "shipping" | "about" | "faq", "read" | PageWhy>;

/** What Luke is told of the site: what was read and what was not, and that a page not found is not a policy missing. */
export function describeCoverage(c: Partial<Coverage> | null | undefined): string | null {
  if (!c) return null;
  const NAMES: Record<string, string> = {
    home: "home page",
    refund: "returns policy",
    shipping: "shipping policy",
    about: "About page",
    faq: "FAQ",
  };
  const by = (w: string) =>
    Object.entries(c)
      .filter(([, v]) => v === w)
      .map(([k]) => NAMES[k] ?? k);
  const parts = [
    by("read").length ? `read: ${by("read").join(", ")}` : "",
    by("not found").length ? `not found: ${by("not found").join(", ")}` : "",
    by("could not be read").length ? `could not be read: ${by("could not be read").join(", ")}` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  return `THEIR WEBSITE, as it was read: ${parts.join("; ")}. A page not found or not read does not mean they have no such policy: never say they have none; ask.`;
}

const PAGE_NAMES: Record<string, string> = {
  home: "home page",
  refund: "returns policy",
  shipping: "shipping policy",
  about: "About page",
  faq: "FAQ",
};

/** The same, as the owner reads it in Settings: "Read: home page, returns policy. Not on the site: FAQ." */
export function coverageSaid(c: Partial<Record<string, string>> | null | undefined): string | null {
  if (!c) return null;
  const by = (w: string) =>
    Object.entries(c)
      .filter(([, v]) => v === w)
      .map(([k]) => PAGE_NAMES[k] ?? k);
  const parts = [
    by("read").length ? `Read: ${by("read").join(", ")}.` : "",
    by("not found").length ? `Not on the site: ${by("not found").join(", ")}.` : "",
    by("could not be read").length ? `Could not be read: ${by("could not be read").join(", ")}.` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}
