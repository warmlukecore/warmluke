// ─────────────────────────────────────────────────────────────
// What their website says (0223, 16 Oct): the store's public home page
// and its refund and shipping policies, read in the background and kept
// as lines of what Luke knows, marked as from the website. No model is
// called: each line is their own words, the sentence that says the thing
// (a return window, a delivery time, cash on delivery, free shipping),
// so Luke never answers a customer question against a guess.
//
// A page on the internet named by a merchant is read from our servers,
// so the read is fenced: http or https on the usual ports, every address
// a name resolves to must be public (checked as the connection is made,
// so a name that changes its answer between check and connect is still
// caught), at most three redirects each checked again, eight seconds and
// a megabyte a page, HTML only.
//
// Callers: src/app/api/site-read/route.ts, scripts/check-site-read.mjs.
// ─────────────────────────────────────────────────────────────

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import type { SupabaseClient } from "@supabase/supabase-js";
import { besideTopic, type Coverage, type PageWhy } from "@/lib/site-coverage";

const PAGE_MS = 8_000;
const PAGE_BYTES = 1_000_000;
const HOPS = 3;
const NOTE_MAX = 200;

/** The addresses no page is read from: private, loopback, link-local, shared, reserved, multicast. */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(net, bits, "ipv6");

/** An address no page may be read from; anything that is not an address at all counts as one. */
export function blockedAddress(ip: string): boolean {
  const v = isIP(ip);
  // An IPv4 address written as IPv6 is never a public site's; as a rule
  // it would also catch every IPv4 address, which BlockList checks mapped.
  if (v === 6 && /^::ffff:/i.test(ip)) return true;
  return v === 0 || BLOCKED.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/** A URL worth trying: http(s), no login in it, the usual ports, not an internal name or a private address. */
export function allowedUrl(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(local|localhost|internal|lan|home|corp)$/.test(host)) return false;
  return isIP(host) ? !blockedAddress(host) : host.includes(".");
}

/** Resolves a name, refusing it if any of its addresses is not public. Node asks this as it connects. */
function publicLookup(
  host: string,
  options: { all?: boolean },
  done: (err: Error | null, address?: string | LookupAddress[], family?: number) => void
) {
  dnsLookup(host, { all: true }, (err, found) => {
    if (err) return done(err);
    if (!found.length || found.some((a) => blockedAddress(a.address)))
      return done(new Error(`${host} is not a public address`));
    if (options.all) done(null, found);
    else done(null, found[0].address, found[0].family);
  });
}

type Got = { status: number; location?: string; html?: string };

function get(u: URL): Promise<Got | null> {
  return new Promise((resolve) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      u,
      {
        lookup: publicLookup as never,
        headers: { "user-agent": "WarmlukeBot/1.0 (reads a store's public pages for its owner)", accept: "text/html" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location });
        }
        if (status !== 200 || !/text\/html/i.test(String(res.headers["content-type"] ?? ""))) {
          res.resume();
          return resolve({ status });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          // What came first is enough: a policy is near the top.
          if (size >= PAGE_BYTES) res.destroy();
        });
        const end = () => resolve({ status, html: Buffer.concat(chunks).subarray(0, PAGE_BYTES).toString("utf8") });
        res.on("end", end);
        res.on("close", end);
        res.on("error", end);
      }
    );
    req.setTimeout(PAGE_MS, () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** One page, redirects followed and each checked again; null when it cannot be read. */
export async function fetchPage(raw: string): Promise<{ url: string; html: string } | null> {
  const r = await readPage(raw);
  return "html" in r ? r : null;
}

/** One page, with why not when it was not read: a page not found is not a page that does not exist in their business. */
export async function readPage(raw: string): Promise<{ url: string; html: string } | { why: PageWhy }> {
  const no = { why: "could not be read" as const };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return no;
  }
  for (let hop = 0; hop <= HOPS; hop++) {
    if (!allowedUrl(u)) return no;
    const got = await get(u);
    if (!got) return no;
    if (got.location) {
      try {
        u = new URL(got.location, u);
      } catch {
        return no;
      }
      continue;
    }
    if (got.status === 404 || got.status === 410) return { why: "not found" };
    // A store behind its password page has nothing public to read.
    if (got.status !== 200 || !got.html || /\/password\/?$/.test(u.pathname)) return no;
    return { url: u.href, html: got.html };
  }
  return no;
}

// ── What a page says ────────────────────────────────────────

export type Page = { title: string; description: string; text: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rupee: "₹",
};
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const squash = (s: string) =>
  decode(s)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const meta = (html: string, name: string) => {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
  return tag ? squash(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "") : "";
};

/** A page as words: its title, its description, and the text of its main part without scripts or menus. */
export function pageOf(html: string): Page {
  const title = squash(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = meta(html, "description") || meta(html, "og:description");
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  const text = squash(
    main
      .replace(/<(script|style|noscript|svg|template|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, ". ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/(\.\s*){2,}/g, ". ");
  return { title, description, text };
}

const DAYS = /\b\d{1,3}\s*(?:(?:-|–|to)\s*\d{1,3}\s*)?(?:business |working )?(?:days?|hours?|weeks?)\b/i;

const clip = (s: string) => {
  const t = s.trim();
  if (t.length <= NOTE_MAX) return t;
  const cut = t.slice(0, NOTE_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 120 ? cut.lastIndexOf(" ") : cut.length)}…`;
};

/**
 * A page's words are data, never orders (the sprint's rule for anything
 * read off the web): a sentence that talks to an AI, or carries markup or
 * a role marker, is never kept as something Luke knows.
 */
const TALKS_TO_AI =
  /\b(ignore|disregard|forget|override)\b[^.]{0,60}\b(instructions?|prompts?|rules?|previous|above|everything)\b|\bsystem prompt\b|\byou are (now )?(an? |the )?(ai|assistant|chatbot|language model|llm|gpt|claude)\b|\bas an ai\b|\b(assistant|system|developer|user)\s*:|<\/?[a-z][^>]*>|\bjailbreak\b|\bprompt injection\b/i;
export const talksToAI = (s: string) => TALKS_TO_AI.test(s);

/** The first sentence about the thing, one that names a time first; null when the page never says it. */
export function sentenceOn(text: string, about: RegExp, prefer: RegExp | null = DAYS): string | null {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    // A heading ("Shipping policy.") is not a sentence that says anything.
    .filter((s) => s.length >= 12 && s.length <= 3000 && s.split(" ").length >= 4);
  // Nor is a disclaimer in capitals the policy itself.
  const shouted = (s: string) => (s.match(/[A-Z]/g)?.length ?? 0) > 0.6 * (s.match(/[A-Za-z]/g)?.length ?? 1);
  // A question (an FAQ's) never says the policy: its answer does.
  const on = sentences.filter((s) => about.test(s) && !shouted(s) && !talksToAI(s) && !s.endsWith("?"));
  const best = (prefer && on.find((s) => prefer.test(s))) || on[0];
  return best ? clip(best) : null;
}

export type SiteNote = { note: string; kind: "policy" | "product"; topic: string; source: "website" };

/** The lines a site gives Luke: what they sell, how returns, delivery, cash on delivery and free shipping work. */
export function siteFacts(p: {
  home?: Page | null;
  refund?: Page | null;
  shipping?: Page | null;
  about?: Page | null;
  faq?: Page | null;
}): SiteNote[] {
  const out: SiteNote[] = [];
  const add = (kind: SiteNote["kind"], topic: string, note: string | null) => {
    if (note && note.length >= 3 && !out.some((n) => n.note === note))
      out.push({ note, kind, topic, source: "website" });
  };
  const about = p.home?.description ?? "";
  if (about.length >= 20 && !talksToAI(about)) add("product", "what they sell", clip(about));
  // Who they are, from their About page: its first sentence that says something.
  if (p.about) add("product", "about them", sentenceOn(p.about.text, /\w/, /\b(we|our|founded|since|started)\b/i));
  // A policy page first; where there is none, what their FAQ says of it.
  const returns = /\b(return|exchange|refund)/i;
  const ships = /\b(ship|deliver|dispatch)/i;
  add(
    "policy",
    "policy: returns",
    (p.refund && sentenceOn(p.refund.text, returns)) || (p.faq && sentenceOn(p.faq.text, returns)) || null
  );
  add(
    "policy",
    "policy: shipping",
    (p.shipping && sentenceOn(p.shipping.text, ships)) || (p.faq && sentenceOn(p.faq.text, ships)) || null
  );
  const all = [p.shipping, p.refund, p.faq, p.home, p.about].filter(Boolean).map((x) => x!.text);
  for (const t of all) {
    if (!out.some((n) => n.topic === "policy: cash on delivery"))
      add("policy", "policy: cash on delivery", sentenceOn(t, /[Cc]ash [Oo]n [Dd]elivery|\bCOD\b/, null));
    if (!out.some((n) => n.topic === "policy: free shipping"))
      add("policy", "policy: free shipping", sentenceOn(t, /free (shipping|delivery)/i, /\d/));
  }
  return out;
}

/** Where to read: the website they gave, else their store's own address. */
export function siteBase(website: string | null, shopDomain: string | null): string | null {
  const given = website?.trim();
  if (given) return /^https?:\/\//i.test(given) ? given : `https://${given}`;
  return shopDomain ? `https://${shopDomain}` : null;
}

export const SITE_PAGES = ["/policies/refund-policy", "/policies/shipping-policy"] as const;
/** Where a store keeps its About and FAQ pages, the common names first. */
export const ABOUT_PAGES = ["/pages/about-us", "/pages/about"] as const;
export const FAQ_PAGES = ["/pages/faq", "/pages/faqs"] as const;

/** The website the owner gave in onboarding, and their store's address. */
export async function siteOf(
  db: SupabaseClient,
  projectId: string
): Promise<{ website: string | null; shopDomain: string | null } | null> {
  const [{ data: project }, { data: stores }] = await Promise.all([
    db.from("projects").select("owner_id").eq("id", projectId).maybeSingle(),
    db.from("stores").select("shop_domain").eq("project_id", projectId).limit(1),
  ]);
  if (!project) return null;
  const { data: profile } = await db.from("profiles").select("website").eq("user_id", project.owner_id).maybeSingle();
  return {
    website: (profile?.website as string | null)?.trim() || null,
    shopDomain: (stores?.[0]?.shop_domain as string | undefined) ?? null,
  };
}

/**
 * Keeps the site's lines, under the caller's own rights. One on a topic
 * the owner already spoke to is refused by its index and theirs stands;
 * what the page promises is kept beside it (besideTopic), so Luke sees
 * both and asks which holds rather than losing either.
 */
export async function keepSiteNotes(db: SupabaseClient, projectId: string, notes: SiteNote[]): Promise<SiteNote[]> {
  const learned: SiteNote[] = [];
  for (const n of notes) {
    let kept: SiteNote = n;
    let { error } = await db.from("merchant_notes").insert({ project_id: projectId, ...n });
    if (error?.code === "23505") {
      kept = { ...n, topic: besideTopic(n.topic) };
      ({ error } = await db.from("merchant_notes").insert({ project_id: projectId, ...kept }));
    }
    if (!error) learned.push(kept);
  }
  return learned;
}

/**
 * Reads the site and keeps what it says, under the owner's own rights:
 * what the website said before is replaced, and a topic the owner already
 * spoke to is left as they said it, with the page's word beside it.
 */
export async function readSite(
  db: SupabaseClient,
  projectId: string
): Promise<{ from: string; pages: number; learned: SiteNote[]; coverage: Coverage } | { error: string }> {
  const site = await siteOf(db, projectId);
  if (!site) return { error: "No such project." };
  const base = siteBase(site.website, site.shopDomain);
  if (!base) return { error: "There is no website or store to read yet." };
  const home = await readPage(base);
  // Where the store really lives, once it has said (a myshopify address sends on to its own).
  let origin: string;
  try {
    origin = new URL("html" in home ? home.url : base).origin;
  } catch {
    return { error: "That website address cannot be read." };
  }
  // The first of a page's usual names that is there; the last answer when none is.
  const firstOf = async (paths: readonly string[]) => {
    let last: Awaited<ReturnType<typeof readPage>> = { why: "not found" };
    for (const path of paths) {
      last = await readPage(origin + path);
      if ("html" in last) return last;
    }
    return last;
  };
  const [refund, shipping, about, faq] = await Promise.all([
    readPage(origin + SITE_PAGES[0]),
    readPage(origin + SITE_PAGES[1]),
    firstOf(ABOUT_PAGES),
    firstOf(FAQ_PAGES),
  ]);
  const read = { home, refund, shipping, about, faq };
  const page = (r: Awaited<ReturnType<typeof readPage>>) => ("html" in r ? pageOf(r.html) : null);
  const notes = siteFacts({
    home: page(home),
    refund: page(refund),
    shipping: page(shipping),
    about: page(about),
    faq: page(faq),
  });
  const coverage = Object.fromEntries(
    Object.entries(read).map(([k, r]) => [k, "html" in r ? "read" : r.why])
  ) as Coverage;
  const gone = await db.from("merchant_notes").delete().eq("project_id", projectId).eq("source", "website");
  if (gone.error) return { error: gone.error.message };
  const learned = await keepSiteNotes(db, projectId, notes);
  await db.from("projects").update({ site_coverage: coverage }).eq("id", projectId);
  return { from: origin, pages: Object.values(read).filter((r) => "html" in r).length, learned, coverage };
}
