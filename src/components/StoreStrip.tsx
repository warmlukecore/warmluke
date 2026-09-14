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

export default function StoreStrip({ projectId }: { projectId: string }) {
  const [store, setStore] = useState<{
    id: string;
    shop_domain: string;
    status: string;
  } | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Survives re-renders, and is flipped on unmount so a merchant who
  // navigates away does not leave a loop calling the route forever.
  const cancelled = useRef(false);

  const pump = useCallback(async () => {
    setRunning(true);
    setError(null);
    for (let i = 0; i < MAX_PAGES && !cancelled.current; i++) {
      const { ok, data } = await apiFetch("/api/shopify/import", { projectId });
      if (data?.progress) setProgress(data.progress as Progress);
      if (!ok) {
        // Stop rather than retry. The route records the failure against
        // the resource, so a later retry resumes; looping here would
        // hammer Shopify with the request that just failed.
        setError((data?.error as string) ?? "The import stopped.");
        break;
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

  if (!store) return null;

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
          <button onClick={pump} className="underline hover:text-rose-700">
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
        <span className="text-slate-500">{counts.join(" · ")}</span>
      ) : (
        <span className="text-slate-500">Nothing imported yet</span>
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
