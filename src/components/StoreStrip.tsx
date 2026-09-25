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
import { ago } from "@/lib/when";
import ConnectShopify from "@/components/ConnectShopify";
import { Dialog } from "@/components/ui/Dialog";
import { Check, Plug, RefreshCw, TriangleAlert } from "lucide-react";

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

type StoreRow = {
  id: string;
  shop_domain: string;
  status: string;
  /** Why Shopify was never asked to send updates, if it was not. */
  webhook_error?: string | null;
  last_synced_at?: string | null;
};

/**
 * The store's standing, at the foot of the sidebar: connected and when
 * it last synced, the import while it runs, and anything that needs the
 * merchant — said there, quietly when all is well and plainly when not.
 *
 * It used to be a line across the top of every section listing how many
 * rows of each list had arrived, which is a fact nobody needed on every
 * screen. The sections themselves say what they hold.
 */
export default function StoreStrip({
  projectId,
  canManage,
  onStatus,
}: {
  projectId: string;
  /** The owner: only they can start an import, reconnect or connect. */
  canManage: boolean;
  /** Told when the store is found, when an import starts or ends, and when it is read again. */
  onStatus?: (s: { storeId: string | null; status: string | null; importing: boolean; synced: number }) => void;
}) {
  const [store, setStore] = useState<StoreRow | null | undefined>(undefined);
  const [progress, setProgress] = useState<Progress>({});
  /** Rows we hold that the last pass did not bring back from Shopify. */
  const [drift, setDrift] = useState<Record<string, { holding: number; imported: number }> | null>(null);
  const [running, setRunning] = useState(false);
  /** The server is doing the import, so closing the tab stops nothing. */
  const [onServer, setOnServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Just finished a check the merchant asked for, to say so for a moment. */
  const [justChecked, setJustChecked] = useState(false);
  /** What the running pass is: the first import, a check for updates, or a retry. */
  const [mode, setMode] = useState<"start" | "recheck" | "retry">("start");
  const [now, setNow] = useState(() => Date.now());
  // Survives re-renders, and is flipped on unmount so a merchant who
  // navigates away does not leave a loop calling the route forever.
  const cancelled = useRef(false);
  // Kept beside the state as well: a check that just finished asks whether
  // it failed before React has drawn the failure.
  const errorRef = useRef<string | null>(null);
  const fail = (message: string) => {
    errorRef.current = message;
    setError(message);
  };
  const synced = useRef(0);
  const status = useRef(onStatus);
  useEffect(() => {
    status.current = onStatus;
  }, [onStatus]);

  const readStore = useCallback(async () => {
    const { data: row } = await supabase
      .from("stores")
      .select("id, shop_domain, status, webhook_error, last_synced_at")
      .eq("project_id", projectId)
      .maybeSingle();
    if (cancelled.current) return null;
    setStore((row as StoreRow | null) ?? null);
    setNow(Date.now());
    return (row as StoreRow | null) ?? null;
  }, [projectId]);

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
        fail(stopped.error ?? "The import stopped.");
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
        setDrift((data.drift as Record<string, { holding: number; imported: number }> | undefined) ?? null);
      }
      if (!ok) {
        if (data?.retryable && stumbles < IMPORT_RETRIES) {
          stumbles++;
          setError(null);
          await new Promise((r) => setTimeout(r, 2000 * stumbles));
          continue;
        }
        fail((data?.error as string) ?? "The import stopped.");
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
      setMode(mode);
      setRunning(true);
      errorRef.current = null;
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

  useEffect(() => {
    cancelled.current = false;
    (async () => {
      const row = await readStore();
      if (!row || cancelled.current) {
        status.current?.({ storeId: null, status: null, importing: false, synced: synced.current });
        return;
      }
      // Only the owner can ask where an import stands — the route reads the
      // store's token, which answers nobody else — so a member is shown what
      // the store row says and nothing that would only fail for them.
      if (!canManage || row.status !== "connected") {
        status.current?.({ storeId: row.id, status: row.status, importing: false, synced: synced.current });
        return;
      }
      // Asked of the route rather than read off import_runs: the route
      // knows every resource there is, and this used to check four
      // names it had by heart — so a fifth resource, still pending,
      // would never have started.
      const { data } = await apiFetch("/api/shopify/import", { projectId, status: true });
      if (cancelled.current) return;
      setProgress((data?.progress as Progress | undefined) ?? {});
      // Nothing has finished yet, or something is part way through.
      // Either way the merchant is waiting on it, so start.
      if (!data?.done) pump();
      else status.current?.({ storeId: row.id, status: row.status, importing: false, synced: synced.current });
    })();
    return () => {
      cancelled.current = true;
    };
  }, [projectId, canManage, pump, readStore]);

  // Tell the page when an import starts and ends, so what it shows can
  // grow with it and count again once it is done.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!store) return;
    if (wasRunning.current && !running) {
      synced.current += 1;
      readStore();
    }
    wasRunning.current = running;
    status.current?.({ storeId: store.id, status: store.status, importing: running, synced: synced.current });
  }, [running, store, readStore]);

  // "Synced 5 min ago" moves on by itself while the page is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  async function checkNow() {
    if (running) return;
    setJustChecked(false);
    await pump("recheck");
    if (!cancelled.current && !errorRef.current) {
      setJustChecked(true);
      setTimeout(() => setJustChecked(false), 4000);
    }
  }

  if (store === undefined) {
    return <div className="h-9 animate-pulse rounded-control bg-frame-raised/60" aria-busy />;
  }

  const connectDialog = connecting && (
    <Dialog
      title={store ? `Reconnect ${store.shop_domain}` : "Connect your Shopify store"}
      description="Warmluke reads your store, and changes nothing in it unless you say yes to that change."
      onClose={() => setConnecting(false)}
    >
      <ConnectShopify
        projectId={projectId}
        initialShop={store?.shop_domain ?? ""}
        submitLabel={store ? "Reconnect" : "Connect"}
        onCancel={() => setConnecting(false)}
      />
    </Dialog>
  );

  // No store on this project. The builder screen used to say nothing
  // about Shopify at all, so the only way to find the connect button
  // was to go back to the dashboard and notice it on the card.
  if (!store) {
    if (!canManage) return null;
    return (
      <>
        <button
          onClick={() => setConnecting(true)}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[13px] text-frame-fg transition-colors hover:bg-frame-raised"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-[6px] border border-dashed border-frame-line text-frame-fg-muted">
            <Plug aria-hidden size={13} strokeWidth={2} />
          </span>
          Connect Shopify
        </button>
        {connectDialog}
      </>
    );
  }

  // Shopify told us the app was taken off this store: its token is gone,
  // so nothing can be read until they connect it again. Said plainly,
  // with the way back, rather than a line that still looks connected.
  if (store.status === "uninstalled" || store.status === "pending") {
    const removed = store.status === "uninstalled";
    return (
      <>
        <Line tone="attention" icon={<TriangleAlert aria-hidden size={13} strokeWidth={2} />}>
          <span
            className="min-w-0 flex-1 truncate"
            title={removed ? "Warmluke was removed from this store in Shopify" : undefined}
          >
            {removed ? "Removed from Shopify" : "Waiting for Shopify"}
          </span>
          {canManage && (
            <button
              onClick={() => setConnecting(true)}
              className="shrink-0 font-medium text-frame-fg underline-offset-2 hover:underline"
            >
              Reconnect
            </button>
          )}
        </Line>
        {connectDialog}
      </>
    );
  }

  const lists = Object.values(progress);
  const done = lists.filter((p) => p.status === "done").length;
  const trouble = store.webhook_error
    ? {
        text: "Updates are not coming in",
        why: `Shopify was not asked to send updates: ${store.webhook_error}. Reconnecting asks again.`,
      }
    : drift && Object.keys(drift).length > 0
      ? {
          text: "Some rows are gone from Shopify",
          why: `${Object.entries(drift)
            .map(([resource, d]) => `${d.holding - d.imported} ${progress[resource]?.label ?? resource}`)
            .join(
              ", "
            )} no longer in Shopify. Nothing has been deleted here. Reconnecting the store re-subscribes its updates.`,
        }
      : null;

  return (
    <>
      {running ? (
        // The running count, not a spinner: the merchant can see it is
        // moving and roughly how far it has got. A check for updates
        // reads everything again, so it says that instead of a count.
        <div
          className="px-2 py-1.5"
          title={onServer ? "Carries on if you close this tab" : "Keep this tab open until it finishes"}
        >
          <div className="flex items-center gap-2 text-[12px] text-frame-fg">
            <RefreshCw aria-hidden size={12} strokeWidth={2} className="animate-spin text-frame-fg-muted" />
            <span className="flex-1 truncate">
              {mode === "recheck" ? "Checking for updates" : mode === "retry" ? "Trying again" : "Importing your store"}
            </span>
            {mode !== "recheck" && lists.length > 0 && done < lists.length && (
              <span className="text-[11px] text-frame-fg-muted tabular-nums">
                {done} of {lists.length}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-frame-line">
            {mode === "recheck" || !lists.length || done >= lists.length ? (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-signal-success/70" />
            ) : (
              <div
                className="h-full rounded-full bg-signal-success transition-[width] duration-500"
                style={{ width: `${Math.max(6, (done / lists.length) * 100)}%` }}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="h-2 w-2 shrink-0 rounded-full bg-signal-success" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[12px] text-frame-fg">{justChecked ? "Up to date" : "Connected"}</span>
            <span className="block truncate text-[11px] text-frame-fg-muted">
              synced {ago(store.last_synced_at, now, "not yet")}
            </span>
          </span>
          {canManage && (
            <button
              onClick={checkNow}
              title="Read the store again from Shopify"
              aria-label="Check for updates"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-control px-2 text-[11px] font-medium text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-frame-fg"
            >
              {justChecked ? (
                <Check aria-hidden size={13} strokeWidth={2.25} className="text-signal-success" />
              ) : (
                <RefreshCw aria-hidden size={13} strokeWidth={2} />
              )}
              Check
            </button>
          )}
        </div>
      )}
      {/* A pass that stopped does not undo the store: it stays connected,
          with what it had, and the stop is said under it — short, with
          Shopify's own words kept for whoever points at it. */}
      {error && !running && (
        <Line tone="critical" icon={<TriangleAlert aria-hidden size={13} strokeWidth={2} />}>
          <span className="min-w-0 flex-1 truncate" title={error}>
            {mode === "recheck" ? "Couldn\u2019t reach Shopify" : "The import stopped"}
          </span>
          {canManage && (
            <button
              onClick={() => (mode === "recheck" ? checkNow() : pump("retry"))}
              className="shrink-0 font-medium text-frame-fg underline-offset-2 hover:underline"
            >
              Try again
            </button>
          )}
        </Line>
      )}
      {/* Webhooks keep the store current, and one that never arrives is
          missed in silence: a subscription that failed to register, an
          outage, a topic Shopify switched off. Said here, where the store
          is, rather than nowhere. */}
      {trouble && !running && (
        <Line tone="attention" icon={<TriangleAlert aria-hidden size={13} strokeWidth={2} />}>
          <span className="min-w-0 flex-1 truncate" title={trouble.why}>
            {trouble.text}
          </span>
          {canManage && (
            <button
              onClick={() => setConnecting(true)}
              className="shrink-0 font-medium text-frame-fg underline-offset-2 hover:underline"
            >
              Reconnect
            </button>
          )}
        </Line>
      )}
      {connectDialog}
    </>
  );
}

/** One line of the store's standing that needs attention, on the dark sidebar. */
function Line({
  tone,
  icon,
  children,
}: {
  tone: "attention" | "critical";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={`flex items-center gap-2 rounded-control px-2 py-1.5 text-[12px] ${
        tone === "critical" ? "bg-signal-critical/15 text-frame-fg" : "bg-signal-attention/15 text-frame-fg"
      }`}
    >
      <span className={tone === "critical" ? "text-signal-critical" : "text-signal-attention"}>{icon}</span>
      {children}
    </div>
  );
}
