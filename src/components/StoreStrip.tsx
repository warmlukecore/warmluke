"use client";

// ─────────────────────────────────────────────────────────────
// StoreStrip — what happened to the store the merchant just connected.
//
// Until now connecting succeeded silently: Shopify sent the merchant
// back and the app showed them the builder as though nothing had
// happened. This says the shop is attached, runs the import, and then
// says what actually arrived.
//
// The import itself runs on the server: this asks the database to send
// it to the worker, and then only watches, so closing the tab stops
// nothing. Where there is no worker — the database answers
// "not_configured" — it does the work from here, a page per request,
// the way it always did.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { apiFetch } from "@/lib/auth";
import { STORE_TABLES } from "@/lib/store-read";
import ConnectShopify from "@/components/ConnectShopify";
import { TriangleAlert } from "lucide-react";

/**
 * Where each resource stands, as the import route reports it: what to
 * call it and which table holds it come from the server's one list of
 * resources, so nothing here has to know their names.
 */
type Progress = Record<string, { imported: number; status: string; label?: string; holds?: string }>;

/** A page is 50 rows, so driving from here stops at 20,000 of any one
 *  resource. Bounded so a cursor bug cannot spin forever; the worker
 *  has no such ceiling, and this only runs where there is no worker. */
const MAX_PAGES = 400;

/** Consecutive stumbles the client rides out before it says so. */
const IMPORT_RETRIES = 3;

/** How often the strip asks where a server-side import has got to. */
const WATCH_MS = 3000;

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
    /** Why Shopify was never asked to send updates, if it was not. */
    webhook_error?: string | null;
  } | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  /** What is in the store now, as opposed to what the import brought. */
  const [held, setHeld] = useState<Record<string, number> | null>(null);
  /** Rows we hold that the last pass did not bring back from Shopify. */
  const [drift, setDrift] = useState<Record<string, { holding: number; imported: number }> | null>(
    null
  );
  const [running, setRunning] = useState(false);
  /** The server is doing the import, so closing the tab stops nothing. */
  const [onServer, setOnServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Survives re-renders, and is flipped on unmount so a merchant who
  // navigates away does not leave a loop calling the route forever.
  const cancelled = useRef(false);
  const [makingSections, setMakingSections] = useState(false);
  const [offerDismissed, setOfferDismissed] = useState(false);

  /**
   * The store lists worth a section: rows imported, none built yet.
   * Read from the one declaration of the store's lists, so a list
   * added there is offered here without anyone remembering to.
   */
  const missing = Object.entries(STORE_TABLES).filter(
    ([table, spec]) =>
      !existingSources.includes(table) && (progress[spec.section.importedWith]?.imported ?? 0) > 0
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
    for (const [table, spec] of missing) {
      const { ok, data } = await apiFetch("/api/modules", {
        projectId,
        nav_label: spec.section.label,
        icon: spec.section.icon,
        source_table: table,
      });
      if (!ok) failed.push(spec.section.label);
    }
    setMakingSections(false);
    onSectionsCreated();
    if (failed.length) {
      setError(`Couldn't add ${failed.join(", ")}. The rest are in — try again for these.`);
    }
  }

  /**
   * The server is doing it: say where it stands until it is finished,
   * or stops and needs the merchant. Nothing here does the work, so
   * leaving the page costs the import nothing.
   * ponytail: polls until done; a dead worker is re-sent by the tick
   * within a minute, so there is no stall detection here.
   */
  const watch = useCallback(async () => {
    while (!cancelled.current) {
      const { data } = await apiFetch("/api/shopify/import", { projectId, status: true });
      if (cancelled.current) return;
      if (data?.progress) setProgress(data.progress as Progress);
      const stopped = data?.stopped as { error?: string | null } | undefined;
      if (stopped) {
        setError(stopped.error ?? "The import stopped.");
        return;
      }
      if (data?.done) {
        // Asked once more as the owner, which reaches the finished
        // branch: it reads nothing from Shopify and says what drifted.
        const { data: last } = await apiFetch("/api/shopify/import", { projectId });
        if (last?.progress) setProgress(last.progress as Progress);
        setDrift((last?.drift as Record<string, { holding: number; imported: number }> | undefined) ?? null);
        return;
      }
      await new Promise((r) => setTimeout(r, WATCH_MS));
    }
  }, [projectId]);

  /** The merchant's own tab does it, a page at a time: the way with no worker. */
  const drive = useCallback(async () => {
    // A throttle or a dropped connection is Shopify asking for a
    // moment, not a merchant's problem to solve with a button. The
    // client tries again on its own a few times, waiting longer each
    // time; anything still failing after that is real and is shown.
    let stumbles = 0;
    for (let i = 0; i < MAX_PAGES && !cancelled.current; i++) {
      const { ok, data } = await apiFetch("/api/shopify/import", { projectId });
      if (data?.progress) setProgress(data.progress as Progress);
      if (data?.done) {
        setDrift(
          (data.drift as Record<string, { holding: number; imported: number }> | undefined) ?? null
        );
      }
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
  }, [projectId]);

  /**
   * Start, check for changes, or try again — and then either watch the
   * server do it or, where there is no worker, do it from here. Which
   * one is the database's answer to the kick, not a guess made here.
   */
  const pump = useCallback(
    async (mode: "start" | "recheck" | "retry" = "start") => {
      setRunning(true);
      setError(null);
      setOnServer(false);
      // Reading Shopify over from the start. Everything on this path is
      // an upsert keyed on the Shopify id, so a second pass costs time
      // and changes nothing that is already right.
      if (mode === "recheck") await apiFetch("/api/shopify/import", { projectId, recheck: true });
      if (mode === "retry") await apiFetch("/api/shopify/import", { projectId, retry: true });
      const { data: k } = await apiFetch("/api/shopify/import", { projectId, kick: true });
      if (k?.kicked === "sent" || k?.kicked === "busy") {
        setOnServer(true);
        await watch();
      } else {
        await drive();
      }
      setRunning(false);
    },
    [projectId, watch, drive]
  );

  // The strip read import_runs.imported — how many the first import
  // carried across. Webhooks have been adding rows ever since without
  // touching that number, so the header said "21 products" over a
  // section listing 26. A merchant reads this as what they have.
  const countHeld = useCallback(async (storeId: string, of: Progress) => {
    const count = async (table: string) =>
      (await supabase.from(table).select("id", { count: "exact", head: true }).eq("store_id", storeId))
        .count ?? 0;
    const counted = await Promise.all(
      Object.entries(of)
        .filter(([, p]) => p.holds)
        .map(async ([key, p]) => [key, await count(p.holds!)] as const)
    );
    if (!cancelled.current) setHeld(Object.fromEntries(counted));
  }, []);

  useEffect(() => {
    cancelled.current = false;
    (async () => {
      const { data: row } = await supabase
        .from("stores")
        .select("id, shop_domain, status, webhook_error")
        .eq("project_id", projectId)
        .maybeSingle();
      if (!row || cancelled.current) return;
      setStore(row);

      // Asked of the route rather than read off import_runs: the route
      // knows every resource there is, and this used to check four
      // names it had by heart — so a fifth resource, still pending,
      // would never have started.
      const { data } = await apiFetch("/api/shopify/import", { projectId, status: true });
      const seen = (data?.progress as Progress | undefined) ?? {};
      if (cancelled.current) return;
      setProgress(seen);

      // Nothing has finished yet, or something is part way through.
      // Either way the merchant is waiting on it, so start.
      if (row.status === "connected" && !data?.done) pump();
      else await countHeld(row.id, seen);
    })();
    return () => {
      cancelled.current = true;
    };
  }, [projectId, pump, countHeld]);

  // And again when they come back from Shopify, which is when the
  // webhooks they triggered have landed.
  useEffect(() => {
    if (!store?.id || running) return;
    const refresh = () => {
      if (document.visibilityState === "visible") countHeld(store.id, progress);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [store?.id, running, countHeld, progress]);

  // No store on this project. The builder screen used to say nothing
  // about Shopify at all, so the only way to find the connect button
  // was to go back to the dashboard and notice it on the card.
  if (!store) {
    return connecting ? (
      <div className="mb-4 max-w-sm rounded-xl border border-line bg-white p-3">
        <ConnectShopify projectId={projectId} onCancel={() => setConnecting(false)} />
      </div>
    ) : (
      <Strip>
        <span className="text-fg-muted">
          Selling on Shopify? Connect the store and your orders, customers and stock
          come across on their own.
        </span>
        <button
          onClick={() => setConnecting(true)}
          className="font-medium text-link hover:text-link"
        >
          Connect Shopify
        </button>
      </Strip>
    );
  }

  // Shopify told us the app was taken off this store: its token is gone,
  // so nothing can be read until they connect it again. Said plainly,
  // with the way back, rather than a strip that still looks connected.
  if (store.status === "uninstalled") {
    return connecting ? (
      <div className="mb-4 max-w-sm rounded-xl border border-line bg-white p-3">
        <ConnectShopify
          projectId={projectId}
          initialShop={store.shop_domain}
          submitLabel="Reconnect"
          onCancel={() => setConnecting(false)}
        />
      </div>
    ) : (
      <Strip>
        <span className="text-tone-attention-fg">
          Warmluke was removed from {store.shop_domain} in Shopify, so it can&rsquo;t read the
          store until you connect it again.
        </span>
        <button onClick={() => setConnecting(true)} className="font-medium text-link hover:text-link">
          Reconnect
        </button>
      </Strip>
    );
  }

  if (store.status === "pending") {
    return (
      <Strip>
        <span className="text-tone-attention-fg">Waiting for Shopify to finish connecting.</span>
      </Strip>
    );
  }

  const counts = Object.entries(progress)
    // While importing, the running total is the point. Once it is done,
    // what matters is what the store holds.
    .map(([key, p]) => [(running ? p.imported : held?.[key]) ?? p.imported ?? 0, p.label ?? key] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n.toLocaleString()} ${label}`);

  return (
    <Strip>
      <span className="flex items-center gap-1.5 font-medium text-fg">
        <span className="h-1.5 w-1.5 rounded-full bg-signal-success" />
        {store.shop_domain}
      </span>
      {error ? (
        <span className="text-tone-critical-fg">
          {error}{" "}
          <button onClick={() => pump("retry")} className="underline hover:text-tone-critical-fg">
            Try again
          </button>
        </span>
      ) : running ? (
        // The running count, not a spinner: the merchant can see it is
        // moving and roughly how far it has got.
        <span className="text-fg-muted">
          Importing… {counts.length ? counts.join(" · ") : "starting"}
          {onServer && <span className="text-fg-faint"> · carries on if you close this tab</span>}
        </span>
      ) : counts.length ? (
        <span className="flex items-center gap-2 text-fg-muted">
          {counts.join(" · ")}
          {/* Webhooks keep this current, and a webhook that never
              arrives is missed in silence — a subscription that failed
              to register, an outage, a topic Shopify switched off.
              Nothing noticed, because once the import finished it
              stopped reading Shopify at all. */}
          <button
            onClick={() => pump("recheck")}
            className="text-[11px] text-fg-faint underline hover:text-fg-muted"
            title="Read the store again from Shopify"
          >
            Check for changes
          </button>
          {/* Said out loud rather than swept away. A row here that
              Shopify no longer returns was almost certainly deleted
              there while a webhook went undelivered — but a page that
              failed quietly looks the same, and a wrong delete does
              not come back. */}
          {/* Connecting succeeded and the updates did not. Saying only
              "connected" leaves a merchant reading a store that will
              never change again and no reason to doubt it. */}
          {store.webhook_error && (
            <span
              className="text-[11px] text-tone-critical-fg"
              title={store.webhook_error}
            >
              <TriangleAlert aria-hidden size={12} className="mr-1 inline align-[-1px]" />Shopify was not asked to send updates — Reconnect to try again
            </span>
          )}
          {drift && Object.keys(drift).length > 0 && (
            <span
              className="text-[11px] text-tone-attention-fg"
              title="Nothing has been deleted. Reconnecting the store re-subscribes the webhooks."
            >
              <TriangleAlert aria-hidden size={12} className="mr-1 inline align-[-1px]" />
              {Object.entries(drift)
                .map(
                  ([resource, d]) =>
                    `${d.holding - d.imported} ${progress[resource]?.label ?? resource} no longer in Shopify`
                )
                .join(" · ")}
            </span>
          )}
        </span>
      ) : (
        <span className="text-fg-muted">Nothing imported yet</span>
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
            className="rounded-lg bg-primary px-2.5 py-1 font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {makingSections
              ? "Building…"
              : existingSources.length
                ? `Add ${missing.map(([, spec]) => spec.section.label).join(", ")}`
                : "Show them in the app"}
          </button>
          <button
            onClick={() => setOfferDismissed(true)}
            className="text-fg-faint hover:text-fg-muted"
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
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-white px-4 py-2.5 text-xs">
      {children}
    </div>
  );
}
