"use client";

// ─────────────────────────────────────────────────────────────
// Adding the store's lists to the menu, one at a time.
//
// Connecting used to offer every list with rows in one button, and a
// store with a little of everything became nineteen sections nobody
// asked for. Now the four a store is run from are offered together,
// and the rest wait here: each with what it holds and how many rows,
// added with a tap when the merchant wants it.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Check, Plus } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { CORE_STORE_TABLES, CORE_STORE_WORDS, STORE_TABLES, type StoreTable } from "@/lib/store-read";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { button, note } from "@/components/ui/controls";

/** "one row per order — number, customer, total…; what…" → "Number, customer, total…". */
function blurb(table: StoreTable): string {
  const first = STORE_TABLES[table].what.split(";")[0];
  const after = first.includes(" — ") ? first.slice(first.indexOf(" — ") + 3) : first;
  return after.charAt(0).toUpperCase() + after.slice(1);
}

/** Makes a section over each list, carrying on past one that fails. Returns the ones that did not go in. */
export async function addStoreSections(projectId: string, tables: StoreTable[]): Promise<StoreTable[]> {
  const failed: StoreTable[] = [];
  for (const table of tables) {
    const spec = STORE_TABLES[table];
    const { ok } = await apiFetch("/api/modules", {
      projectId,
      nav_label: spec.section.label,
      icon: spec.section.icon,
      source_table: table,
    });
    if (!ok) failed.push(table);
  }
  return failed;
}

const ALL = Object.keys(STORE_TABLES) as StoreTable[];
const MORE = ALL.filter((t) => !CORE_STORE_TABLES.includes(t)).sort((a, b) =>
  STORE_TABLES[a].section.label.localeCompare(STORE_TABLES[b].section.label)
);

export default function StorePicker({
  projectId,
  storeId,
  existingSources,
  onAdded,
  onClose,
}: {
  projectId: string;
  storeId: string;
  /** Lists that already have a section. */
  existingSources: string[];
  onAdded: () => void;
  onClose: () => void;
}) {
  const [counts, setCounts] = useState<Partial<Record<StoreTable, number | null>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>(existingSources);

  // How many rows each list holds, so nobody adds an empty one by accident.
  useEffect(() => {
    let live = true;
    (async () => {
      const got = await Promise.all(
        ALL.map(async (t) => {
          const { count, error: e } = await supabase
            .from(STORE_TABLES[t].view)
            .select("id", { count: "exact", head: true })
            .eq("store_id", storeId);
          return [t, e ? null : (count ?? 0)] as const;
        })
      );
      if (live) setCounts(Object.fromEntries(got));
    })();
    return () => {
      live = false;
    };
  }, [storeId]);

  async function add(which: StoreTable[], key: string) {
    const todo = which.filter((t) => !added.includes(t));
    if (todo.length === 0 || busy) return;
    setBusy(key);
    setError(null);
    const failed = await addStoreSections(projectId, todo);
    setBusy(null);
    setAdded((prev) => [...prev, ...todo.filter((t) => !failed.includes(t))]);
    onAdded();
    if (failed.length)
      setError(`Couldn’t add ${failed.map((t) => STORE_TABLES[t].section.label).join(", ")}. Try again.`);
  }

  const missingCore = CORE_STORE_TABLES.filter((t) => !added.includes(t));

  const row = (t: StoreTable) => {
    const spec = STORE_TABLES[t];
    const isIn = added.includes(t);
    const n = counts[t];
    return (
      <li key={t} className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-canvas text-fg">
          <Icon name={spec.section.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-fg">{spec.section.label}</span>
            <span className="text-[11px] text-fg-faint tabular-nums">
              {n === undefined ? "…" : n === null ? "" : `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`}
            </span>
          </div>
          <p className="truncate text-xs text-fg-muted" title={blurb(t)}>
            {blurb(t)}
          </p>
        </div>
        {isIn ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
            <Check aria-hidden size={14} strokeWidth={2} className="text-signal-success" />
            In the menu
          </span>
        ) : (
          <button onClick={() => add([t], t)} disabled={busy !== null} className={button("secondary", "sm")}>
            <Plus aria-hidden size={13} strokeWidth={2} />
            {busy === t ? "Adding…" : "Add"}
          </button>
        )}
      </li>
    );
  };

  return (
    <Dialog
      tall
      title="Add from your store"
      description="Each list becomes a section in the menu, and keeps filling from Shopify on its own."
      onClose={onClose}
    >
      <div className="space-y-4">
        {error && <div className={note.critical}>{error}</div>}

        <section className="overflow-hidden rounded-card border border-line">
          <header className="flex items-center justify-between gap-3 border-b border-line bg-surface-subdued px-3 py-2.5">
            <div>
              <h3 className="text-[13px] font-semibold text-fg">What a store is run from</h3>
              <p className="text-xs text-fg-muted">
                {CORE_STORE_WORDS.charAt(0).toUpperCase() + CORE_STORE_WORDS.slice(1)}.
              </p>
            </div>
            {missingCore.length > 0 && (
              <button
                onClick={() => add(missingCore, "core")}
                disabled={busy !== null}
                className={button("primary", "sm")}
              >
                {busy === "core"
                  ? "Adding…"
                  : missingCore.length === CORE_STORE_TABLES.length
                    ? `Add all ${CORE_STORE_TABLES.length}`
                    : `Add the other ${missingCore.length}`}
              </button>
            )}
          </header>
          <ul className="divide-y divide-line">{CORE_STORE_TABLES.map(row)}</ul>
        </section>

        <section className="overflow-hidden rounded-card border border-line">
          <header className="border-b border-line bg-surface-subdued px-3 py-2.5">
            <h3 className="text-[13px] font-semibold text-fg">More from your store</h3>
            <p className="text-xs text-fg-muted">Add only what you will open. A section can be removed any time.</p>
          </header>
          <ul className="divide-y divide-line">{MORE.map(row)}</ul>
        </section>
      </div>
    </Dialog>
  );
}
