// Which failures are worth trying again.
//
// Lifted out of lib/ai so the Shopify importer can use the same rule.
// Copying four regexes would have been shorter to write and would have
// drifted the first time one of them learned a new error shape.
//
// Callers: src/lib/ai.ts (model calls, and re-exports this for its own
// callers), src/lib/shopify-import.ts (the Admin API), and
// scripts/check-gates.mjs.

/**
 * Busy, rate-limited or briefly broken — worth trying again. A rejected
 * request or a bad key is not, and retrying one only delays the error
 * the caller needs to see.
 */
export function isTransient(e: unknown): boolean {
  // A model error already says which kind it is; its sentence is for
  // the merchant and carries no status code to read.
  if (e instanceof Error && "kind" in e) {
    const kind = (e as { kind?: string }).kind;
    return kind === "busy" || kind === "down";
  }
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /\b(429|500|502|503|504)\b/.test(msg) ||
    /overload|unavailable|high load|timeout|throttl/i.test(msg)
  );
}
