// The walk page: a section drawn by the app's own components, alone, for
// the tryout's third layer (lib/walk.ts, 5 Oct).
//
// Bundled with the app's CSS into one page (scripts/build-walk-page.mjs),
// opened in a sealed browser with a design and a copy of its rows handed
// in, and walked: every filter, the form, the buttons, the tabs. Nothing
// here reaches a network: rows are kept in memory, a link's rows are the
// ones handed in, and what a person saves is written down for the walker
// to read back. It is GenericRenderer as the merchant gets it, not a copy.

import { createRoot } from "react-dom/client";
import { useState } from "react";
import GenericRenderer from "@/components/GenericRenderer";
import { LinkProvider, type LinkOptions } from "@/components/LinkContext";
import { FormatProvider } from "@/lib/format";
import type { LinkTarget } from "@/lib/links";
import type { RecordRow, UiSchema } from "@/lib/types";

/** What the walk is handed: the section as the design leaves it, its rows, and what its links point at. */
export type WalkInput = {
  schema: UiSchema;
  rows: Array<{ id: string; data: Record<string, unknown> }>;
  links: LinkOptions;
  targets: Record<string, LinkTarget>;
  locale: string;
  currency: string;
  timeZone: string;
};

/** Each save a person made, for the walker to read back. */
export type WalkWrite = { op: "add" | "set" | "remove"; id: string; data?: Record<string, unknown> };

declare global {
  interface Window {
    __WALK__: WalkInput;
    __WALK_WRITES__: WalkWrite[];
    /** What a written screen broke on while it ran: its own errors, calls refused. */
    __WALK_BROKE__: string[];
  }
}

const row = (id: string, data: Record<string, unknown>): RecordRow => ({
  id,
  project_id: "walk",
  module_id: "walk",
  data,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

function Walk({ w }: { w: WalkInput }) {
  const [records, setRecords] = useState<RecordRow[]>(() => w.rows.map((r) => row(r.id, r.data)));
  const wrote = (x: WalkWrite) => window.__WALK_WRITES__.push(x);
  return (
    <FormatProvider locale={w.locale} currency={w.currency}>
      <LinkProvider
        options={w.links}
        source={{
          // A link's rows are the ones handed in, found by what is typed and narrowed as the app narrows them.
          search: async (moduleId, q, narrow) =>
            (w.links[moduleId] ?? []).filter(
              (o) =>
                (!q || o.label.toLowerCase().includes(q.toLowerCase())) &&
                (!narrow || String(o.data?.[narrow.field] ?? "") === narrow.value)
            ),
          targetOf: (moduleId) => w.targets[moduleId] ?? null,
        }}
      >
        <main className="min-h-screen bg-canvas p-3 sm:p-6">
          <GenericRenderer
            schema={w.schema}
            records={records}
            timeZone={w.timeZone}
            onScreenBroke={(screen, message) => window.__WALK_BROKE__.push(`${screen}: ${message}`)}
            // Another section's rows are not handed in: a written screen reading one finds none, as a new app would.
            onReadSection={async () => []}
            onScanGroup={async () => []}
            onCreate={async (data) => {
              const id = `walk-${records.length + 1}`;
              wrote({ op: "add", id, data });
              setRecords((rs) => [row(id, data), ...rs]);
            }}
            onUpdate={async (id, data) => {
              wrote({ op: "set", id, data });
              setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, data: { ...r.data, ...data } } : r)));
            }}
            onDelete={async (id) => {
              wrote({ op: "remove", id });
              setRecords((rs) => rs.filter((r) => r.id !== id));
            }}
          />
        </main>
      </LinkProvider>
    </FormatProvider>
  );
}

window.__WALK_WRITES__ = [];
window.__WALK_BROKE__ = [];
createRoot(document.getElementById("root")!).render(<Walk w={window.__WALK__} />);
