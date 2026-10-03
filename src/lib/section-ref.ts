// A section as a design, a rule or a written screen names it: "#orders",
// "Orders", "#Packing Scan", "order_lines" or its id all mean one section.
//
// Three places looked a section up, each its own way: a build by exact
// name, a screen by lowercased name or label, a rule by exact "#name". A
// rule that wrote sections.orders for "#orders" read nothing and wrote
// nothing on every scan (2026-09-30). One lookup now, for all three.
//
// Callers: src/lib/apply.ts, src/lib/code-rules.ts, src/components/AppShell.tsx.
// The sandbox's runner (lib/code-run RUNNER) spells sectionKey out again: it
// runs sealed off, with nothing to import.

/** One spelling for every way a section's name is written. */
export const sectionKey = (name: string) =>
  name
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");

type Named = { id: string; name?: string | null; nav_label?: string | null };

/** The section `ref` means: by its id, then its exact name, then any spelling of its name or label. */
export function findSection<T extends Named>(sections: readonly T[], ref: string): T | undefined {
  const wanted = ref.trim();
  const bare = wanted.replace(/^#/, "");
  const key = sectionKey(wanted);
  return (
    sections.find((s) => s.id === wanted) ??
    sections.find((s) => s.name === bare) ??
    sections.find((s) => sectionKey(s.name ?? "") === key) ??
    sections.find((s) => sectionKey(s.nav_label ?? "") === key)
  );
}

/**
 * Whether a rule reads a section: a rule of code that lists it in "reads"
 * or names it in its code ("#shipments", sections['shipments']). A section
 * deleted from under one goes on reading nothing, with no error anywhere:
 * a repeat-order rule lost its "still in transit" check that way (3 Oct).
 */
export function readsSection(definition: unknown, section: { id: string; name: string }): boolean {
  const actions =
    (definition as { actions?: Array<{ type?: string; reads?: unknown; code?: unknown }> })?.actions ?? [];
  const name = section.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`["'\`]#?${name}["'\`]`);
  return actions.some(
    (a) =>
      a?.type === "run_code" &&
      ((Array.isArray(a.reads) &&
        a.reads.some((r) => r === section.id || r === `#${section.name}` || r === section.name)) ||
        (typeof a.code === "string" && named.test(a.code)))
  );
}
