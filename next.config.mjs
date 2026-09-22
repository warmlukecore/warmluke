import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

// The one origin the browser is allowed to call besides our own: auth,
// PostgREST and realtime all live there. Read from the environment so
// a preview or a second project does not need this file edited — and
// so nobody has to remember that it exists.
const supabase = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL ?? "";
const supabaseOrigin = supabase ? new URL(supabase).origin : "";
const supabaseSocket = supabaseOrigin.replace(/^https:/, "wss:");

/**
 * Headers every response carries.
 *
 * `script-src` allows 'unsafe-inline', which is not a decision anyone
 * should be proud of — it is what Next needs to hydrate without
 * per-request nonces. Leaving script-src out entirely was worse: it
 * falls back to `default-src 'self'`, which blocks Next's own inline
 * bootstrap, and the app died on React error #412 with the header
 * looking perfectly correct from curl.
 *
 * What it still buys: scripts may only be loaded from this origin, so
 * an injected <script src="evil.com"> is refused even though an
 * injected inline one is not.
 *
 * ponytail: 'unsafe-inline' script-src. Replace with proxy-generated
 * nonces when there is a reason to spend a day on it; that is the only
 * version of this that stops XSS rather than describing it.
 */
const securityHeaders = [
  // Without the Supabase origin this policy would allow 'self' and
  // nothing else, so auth, every query and the realtime socket would
  // all be refused — a dead app, shipped by a header that looks right.
  // The variable is set in production; a preview or a fresh
  // environment that lacks it gets no CSP rather than a fatal one.
  // Every header below this still applies.
  ...(supabaseOrigin
    ? [{
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${supabaseOrigin} ${supabaseSocket}`.trim(),
      "img-src 'self' data: blob: https:",
      // The landing hero's film, which is served from here. Worth
      // saying why the line exists at all: with no media-src this
      // falls back to default-src 'self' and, while that happens to
      // allow our own file, the day the video moves to a CDN the
      // browser refuses it while every header still looks correct
      // from curl. It fails silently — the hero simply never moves.
      // check-csp-media holds this and the page together.
      "media-src 'self'",
      // next/font self-hosts at build time, so no external font origin.
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
      }]
    : []),
  // A merchant's project id travels in the path. It is not a credential
  // — access is decided by row-level security, not by knowing it — but
  // there is no reason to hand it to every site they click through to.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Older browsers that ignore frame-ancestors still read this one.
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so stray lockfiles in parent directories
  // (e.g. ~/package-lock.json) don't confuse module resolution.
  turbopack: {
    root: projectDir,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
