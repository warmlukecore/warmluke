// ─────────────────────────────────────────────────────────────
// Reading a store address the way a merchant actually gives it.
//
// The connect box used to accept exactly one spelling —
// "mystore.myshopify.com" — and refuse the others a merchant is
// likely to have to hand: the bare name, the address copied out of
// their browser, the new admin's URL. Each of those names one store
// unambiguously, so refusing them was only ever friction.
//
// Two rules keep this from becoming a hole:
//
//   the forgiving part only recognises shapes that name a store —
//   it never guesses. A custom domain ("mystore.com") could be any
//   store or none, so it is answered with where to find the real
//   address rather than resolved;
//
//   whatever it reads is then held to the strict pattern below,
//   the same one the OAuth callback uses. The callback itself stays
//   strict: this is for what a person types, not for what Shopify
//   sends back.
//
// No imports on purpose, so the browser can use the same reading the
// server does — the box shows what it understood, and the server
// reads it again rather than trusting the page.
//
// Callers: src/lib/shopify.ts (the pattern), src/app/api/shopify/install/route.ts,
// src/components/ConnectShopify.tsx.
// ─────────────────────────────────────────────────────────────

/**
 * What a Shopify store address is. Anchored, and it must start with a
 * letter or digit: a loose test like /myshopify.com/ matches
 * "evil.com?x=.myshopify.com" and sends the merchant's authorization
 * somewhere else entirely.
 */
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The suffix every store address ends in. */
const SUFFIX = ".myshopify.com";

/** The host of Shopify's own admin, where /store/<handle> names a store. */
const ADMIN_HOST = "admin.shopify.com";

/** A store's handle on its own: what comes before .myshopify.com. */
const HANDLE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Longer than any real address, short enough that pasting a page of
 * text into the box does not become work.
 */
const LONGEST_INPUT = 2048;

/** The longest a domain may be, as DNS has it. */
const LONGEST_DOMAIN = 253;

export type ShopAddress =
  | { domain: string }
  | {
      error: string;
      /** Where to find the address, when it is worth saying. */
      hint?: string;
    };

const WHERE_TO_FIND =
  "It ends in .myshopify.com. In Shopify, open Settings, then Domains, and it is listed there.";

/**
 * The store a merchant meant, from whatever they typed or pasted.
 *
 * Returns the address in the one form Shopify accepts, or a sentence
 * saying what is wrong — never a guess.
 */
export function readShopAddress(input: string): ShopAddress {
  if (typeof input !== "string") return { error: "Enter your store address." };
  if (input.length > LONGEST_INPUT) {
    return { error: "That is much longer than a store address.", hint: WHERE_TO_FIND };
  }

  // What a copy and paste tends to bring with it: invisible
  // zero-width characters, surrounding spaces, quotes (straight or
  // curly, as chat apps and documents write them) or angle brackets,
  // and a full stop at the end of a sentence the address was copied
  // out of.
  const cleaned = input
    .replace(/[​-‍⁠﻿]/g, "")
    .trim()
    .replace(/^["'<`“”‘’\s]+|["'>`“”‘’\s]+$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!cleaned) return { error: "Enter your store address." };

  // A store's name, not its address — "My Store" — has no single
  // spelling as a handle, because Shopify adds to names that are
  // taken. Better to say so than to send them to a store that
  // happens to be called the same.
  if (/\s/.test(cleaned)) {
    return {
      error: "That looks like the store's name rather than its address.",
      hint: WHERE_TO_FIND,
    };
  }

  // The bare handle, "mystore".
  if (HANDLE.test(cleaned)) return strict(`${cleaned}${SUFFIX}`);

  // Anything else is read as an address, with or without its scheme.
  // URL does the part that is easy to get wrong by hand: it separates
  // the host from a path, a port, a query and — importantly — from
  // userinfo, so "https://mystore.myshopify.com@evil.com" is evil.com
  // and is refused, not mystore.
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(cleaned) ? cleaned : `https://${cleaned}`);
  } catch {
    return { error: "That doesn't look like a store address.", hint: WHERE_TO_FIND };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "That doesn't look like a store address.", hint: WHERE_TO_FIND };
  }

  const host = url.hostname.replace(/^www\./, "");

  // Letters outside a–z come back from URL as punycode ("xn--…").
  // No store address is written that way, so it is a name typed in
  // another script, and reading it as a handle would send them to a
  // store that does not exist.
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { error: "A store address uses only a–z, 0–9 and hyphens.", hint: WHERE_TO_FIND };
  }

  // The new admin: admin.shopify.com/store/<handle>/…
  if (host === ADMIN_HOST) {
    const handle = url.pathname.split("/").filter(Boolean);
    if (handle[0] === "store" && handle[1] && HANDLE.test(handle[1])) {
      return strict(`${handle[1]}${SUFFIX}`);
    }
    return {
      error: "That is Shopify's admin, but not a page for one store.",
      hint: "Open your store in Shopify and copy the address from there, or type its name.",
    };
  }

  if (host.endsWith(SUFFIX)) return strict(host);

  // Shopify's own site — a sign-in page, or "mystore.shopify.com"
  // one letter short of the real thing. Not a custom domain, so the
  // hint about one would send them the wrong way.
  if (host === "shopify.com" || host.endsWith(".shopify.com")) {
    return { error: "That is Shopify's own site, not your store's address.", hint: WHERE_TO_FIND };
  }

  // The bare handle with only a scheme or a slash round it:
  // "https://mystore", "mystore/". Nothing else may ride along. With
  // a path, "https://https://mystore.myshopify.com" and
  // "http//mystore.myshopify.com" would read as the stores "https"
  // and "http" — a guess, and a wrong one.
  if (
    !host.includes(".") &&
    HANDLE.test(host) &&
    url.pathname === "/" &&
    !url.search &&
    !url.port &&
    !url.username
  ) {
    return strict(`${host}${SUFFIX}`);
  }

  // A host that is not Shopify's: the store's own domain, most
  // likely, and nothing here can tell which store it belongs to.
  if (host.includes(".")) {
    return {
      error: `${host} is not a Shopify store address.`,
      hint: `If it is your shop's own domain, Warmluke needs the one Shopify gave it instead. ${WHERE_TO_FIND}`,
    };
  }
  return { error: "That doesn't look like a store address.", hint: WHERE_TO_FIND };
}

/** Held to the strict pattern, whatever led here. */
function strict(domain: string): ShopAddress {
  if (domain.length > LONGEST_DOMAIN || !SHOP_DOMAIN.test(domain)) {
    return { error: "That doesn't look like a store address.", hint: WHERE_TO_FIND };
  }
  return { domain };
}
