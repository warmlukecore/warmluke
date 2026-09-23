// No imports, so the checks can run it in Node as the pages do in the browser.

/**
 * Whether a ?next= after signing in is a page of ours. "/" alone is not
 * enough: "//evil.example" and "/\\evil.example" start with it too, and
 * a browser reads both as another site — so a link to our own login page
 * could hand a freshly signed-in merchant to somebody else's.
 */
export function ownPath(next: string | null | undefined): next is string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");
}
