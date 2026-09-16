"use client";

// ─────────────────────────────────────────────────────────────
// StoreStrip — what happened to the store the merchant just connected.
//
// Until now connecting succeeded silently: Shopify sent the merchant
// back and the app showed them the builder as though nothing had
// happened. This says the shop is attached, runs the import, and then
// says what actually arrived.
//
// It is also the only thing that calls the import route. The route does
// one page per request on purpose, so something has to keep asking; a
// screen the merchant is already watching is the honest place to do it,
// because the progress they see is the work itself rather than a guess.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { apiFetch } from "@/lib/auth";
import ConnectShopify from "@/components/ConnectShopify";

type Progress = Record<string, { imported: number; status: string }>;

const LABELS: Record<string, string> = {
  products: "products",
  customers: "customers",
  orders: "orders",
  inventory: "stock levels",
};

/** A page is 50 rows, so this stops at 20,000 of any one resource.
 *  ponytail: bounded so a cursor bug cannot spin forever; move the loop
 *  to a background job when a real store outgrows it. */
const MAX_PAGES = 400;

/** Consecutive stumbles the client rides out before it says so. */
const IMPORT_RETRIES = 3;

export default function StoreStrip({
  projectId,
  existingSources,
  onSectionsCreated,
}: {
  projectId: string;
  /** Store tables that already have a section, so the offer covers the
   *  rest — which is also what makes a half-finished attempt fixable. */
  existingSources: string[];
  onSectionsCreated: () => void;
}) {
  const [store, setStore] = useState<{
    id: string;
    shop_domain: string;
    status: string;
  } | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Survives re-renders, and is flipped on unmount so a merchant who
  // navigates away does not leave a loop calling the route forever.
  const cancelled = useRef(false);
  const [makingSections, setMakingSections] = useState(false);
  const [offerDismissed, setOfferDismissed] = useState(false);

  /** The store tables worth a section: rows imported, none built yet. */
  const WANTED: Array<[string, string, string, string]> = [
    ["orders", "orders", "Orders", "shopping-cart"],
    ["customers", "customers", "Customers", "users"],
    ["products", "products", "Products", "package"],
    ["inventory_levels", "inventory", "Stock", "box"],
  ];
  const missing = WANTED.filter(
    ([table, progressKey]) =>
      !existingSources.includes(table) && (progress[progressKey]?.imported ?? 0) > 0
  );

  /**
   * Builds a section for each store table that has rows and no section.
   *
   * Offered rather than done automatically: a merchant whose whole app
   * is about stock does not want three sections they never open.
   *
   * Carries on past a failure instead of stopping at the first. A flaky
   * request used to leave one section built, the offer gone because the
   * project was no longer empty, and no way back to the other three.
   */
  async function makeSections() {
    setMakingSections(true);
    setError(null);
    const failed: string[] = [];
    for (const [table, , label, icon] of missing) {
      const { ok, data } = await apiFetch("/api/modules", {
        projectId,
        nav_label: label,
        icon,
        source_table: table,
      });
      if (!ok) failed.push(label);
    }
    setMakingSections(false);
    onSectionsCreated();
    if (failed.length) {
      setError(`Couldn't add ${failed.join(", ")}. The rest are in — try again for these.`);
    }
  }

  const pump = useCallback(async (recheck = false) => {
    setRunning(true);
    setError(null);
    // Reading Shopify over from the start. Everything on this path is
    // an upsert keyed on the Shopify id, so a second pass costs time
    // and changes nothing that is already right.
    if (recheck) {
      await apiFetch("/api/shopify/import", { projectId, recheck: true });
    }
    // A throttle or a dropped connection is Shopify asking for a
    // moment, not a merchant's problem to solve with a button. The
    // client tries again on its own a few times, waiting longer each
    // time; anything still failing after that is real and is shown.
    let stumbles = 0;
    for (let i = 0; i < MAX_PAGES && !cancelled.current; i++) {
      const { ok, data } = await apiFetch("/api/shopify/import", { projectId });
      if (data?.progress) setProgress(data.progress as Progress);
      if (!ok) {
        if (data?.retryable && stumbles < IMPORT_RETRIES) {
          stumbles++;
          setError(null);
          await new Promise((r) => setTimeout(r, 2000 * stumbles));
          continue;
        }
        setError((data?.error as string) ?? "The import stopped.");
        break;
      }
      // A page that worked clears the count: a long import is allowed
      // to stumble more than three times in total, just not in a row.
      stumbles = 0;
      // A big store is exported on Shopify's side before there is
      // anything to read. Asking again immediately would just burn
      // through MAX_PAGES waiting.
      if (data?.waiting) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (data?.done) break;
    }
    setRunning(false);
  }, [projectId]);

  useEffect(() => {
    cancelled.current = false;
    (async () => {
      const { data: row } = await supabase
        .from("stores")
        .select("id, shop_domain, status")
        .eq("project_id", projectId)
        .maybeSingle();
      if (!row || cancelled.current) return;
      setStore(row);

      const { data: runs } = await supabase
        .from("import_runs")
        .select("resource, status, imported")
        .eq("store_id", row.id);
      const seen: Progress = {};
      for (const r of runs ?? []) {
        seen[r.resource as string] = { imported: r.imported as number, status: r.status as string };
      }
      if (cancelled.current) return;
      setProgress(seen);

      // Nothing has finished yet, or something is part way through.
      // Either way the merchant is waiting on it, so start.
      const unfinished = Object.keys(LABELS).some((k) => (seen[k]?.status ?? "pending") !== "done");
      if (row.status === "connected" && unfinished) pump();
    })();
    return () => {
      cancelled.current = true;
    };
  }, [projectId, pump]);

  // No store on this project. The builder screen used to say nothing
  // about Shopify at all, so the only way to find the connect button
  // was to go back to the dashboard and notice it on the card.
  if (!store) {
    return connecting ? (
      <div className="mb-4 max-w-sm rounded-xl border border-slate-200 bg-white p-3">
        <ConnectShopify projectId={projectId} onCancel={() => setConnecting(false)} />
      </div>
    ) : (
      <Strip>
        <span className="text-slate-600">
          Selling on Shopify? Connect the store and your orders, customers and stock
          come across on their own.
        </span>
        <button
          onClick={() => setConnecting(true)}
          className="font-medium text-blue-600 hover:text-blue-700"
        >
          Connect Shopify
        </button>
      </Strip>
    );
  }

  if (store.status === "pending") {
    return (
      <Strip>
        <span className="text-amber-600">Waiting for Shopify to finish connecting.</span>
      </Strip>
    );
  }

  const counts = Object.entries(LABELS)
    .map(([key, label]) => [progress[key]?.imported ?? 0, label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n.toLocaleString()} ${label}`);

  return (
    <Strip>
      <span className="flex items-center gap-1.5 font-medium text-slate-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {store.shop_domain}
      </span>
      {error ? (
        <span className="text-rose-600">
          {error}{" "}
          <button onClick={() => pump()} className="underline hover:text-rose-700">
            Try again
          </button>
        </span>
      ) : running ? (
        // The running count, not a spinner: the merchant can see it is
        // moving and roughly how far it has got.
        <span className="text-slate-500">
          Importing… {counts.length ? counts.join(" · ") : "starting"}
        </span>
      ) : counts.length ? (
        <span className="flex items-center gap-2 text-slate-500">
          {counts.join(" · ")}
          {/* Webhooks keep this current, and a webhook that never
              arrives is missed in silence — a subscription that failed
              to register, an outage, a topic Shopify switched off.
              Nothing noticed, because once the import finished it
              stopped reading Shopify at all. */}
          <button
            onClick={() => pump(true)}
            className="text-[11px] text-slate-400 underline hover:text-slate-600"
            title="Read the store again from Shopify"
          >
            Check for changes
          </button>
        </span>
      ) : (
        <span className="text-slate-500">Nothing imported yet</span>
      )}

      {/* The whole point of connecting. Without this the merchant's
          store sits in the database behind an empty sidebar. */}
      {/* Shown whenever a store table has rows and no section, so a
          half-finished attempt can simply be repeated. */}
      {!running && counts.length > 0 && missing.length > 0 && !offerDismissed && (
        <span className="flex items-center gap-2">
          <button
            onClick={makeSections}
            disabled={makingSections}
            className="rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {makingSections
              ? "Building…"
              : existingSources.length
                ? `Add ${missing.map(([, , l]) => l).join(", ")}`
                : "Show them in the app"}
          </button>
          <button
            onClick={() => setOfferDismissed(true)}
            className="text-slate-400 hover:text-slate-600"
          >
            Not now
          </button>
        </span>
      )}
    </Strip>
  );
}

function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs">
      {children}
    </div>
  );
}
