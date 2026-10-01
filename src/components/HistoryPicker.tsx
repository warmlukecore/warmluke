"use client";

// ─────────────────────────────────────────────────────────────
// HistoryPicker — how far back a store's orders and customers come in.
//
// Asked right after Shopify says yes, when the counts can be real: the
// route asks Shopify once what each window would bring. Products come
// in full whatever is chosen, and new orders keep arriving on their own.
//
// The same picker changes it later. A longer window brings in what is
// missing; a shorter one asks whether to keep what is already here, and
// removes it in batches only when told to (0154).
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { button, note } from "@/components/ui/controls";
import { windowName } from "@/lib/when";

type Count = { count: number; precision: string } | null;
type Choice = { days: number; from: string; available: boolean; orders: Count; customers: Count };
type Answer = {
  storeId: string;
  timezone: string | null;
  /** The administrator's default: preselected here, taken by a store nobody chose for. */
  defaultDays: number;
  allOrders: boolean;
  firstOrderAt: string | null;
  products: Count;
  choices: Choice[];
  current: { days: number | null; from: string | null; chosen: boolean };
};
export type HistoryChosen = { days: number; from: string; extended: boolean; removed: number };

/** Removed per request: well inside a statement's time, however many there are. */
const TRIM_BATCH = 2000;

const many = (c: Count) => (c ? `${c.count.toLocaleString()}${c.precision === "AT_LEAST" ? "+" : ""}` : "–");

function day(iso: string, timeZone: string | null) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    // A zone the browser does not know: the date is still right, in the viewer's own.
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
}

export default function HistoryPicker({
  projectId,
  onDone,
  onCancel,
  doneLabel,
}: {
  projectId: string;
  /** Chosen and saved; the caller starts the import. */
  onDone: (chosen: HistoryChosen) => void;
  onCancel?: () => void;
  /** The button's words; "Bring in …" by default. */
  doneLabel?: string;
}) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // A shorter window left orders outside it: keep them, or remove them.
  const [older, setOlder] = useState<{ count: number; from: string; extended: boolean } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setAnswer(null);
    const { ok, data } = await apiFetch("/api/shopify/history", { projectId });
    if (data?.disabled) {
      setError("Choosing how far back is switched off. Everything Shopify shares comes in.");
      return;
    }
    if (!ok) {
      setError((data.error as string) ?? "Couldn’t ask Shopify what each choice would bring.");
      return;
    }
    const a = data as unknown as Answer;
    setAnswer(a);
    const usable = a.choices.filter((c) => c.available).map((c) => c.days);
    const want = a.current.chosen && a.current.days ? a.current.days : a.defaultDays;
    setDays(usable.includes(want) ? want : (usable.filter((d) => d <= want).pop() ?? usable[0] ?? null));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function choose() {
    if (!answer || days === null) return;
    setBusy(true);
    setError(null);
    const { data, error: refused } = await supabase.rpc("abo_store_set_history", {
      p_store: answer.storeId,
      p_days: days,
    });
    setBusy(false);
    if (refused) {
      setError(refused.message);
      return;
    }
    const r = data as { from: string; extended: boolean; older: number };
    // Shorter than before, with orders already here from before it: the
    // merchant says what happens to them. Kept unless they say otherwise.
    if (!r.extended && r.older > 0) {
      setOlder({ count: r.older, from: r.from, extended: r.extended });
      return;
    }
    onDone({ days, from: r.from, extended: r.extended, removed: 0 });
  }

  async function removeOlder() {
    if (!answer || !older || days === null) return;
    setError(null);
    let removed = 0;
    setRemoving(0);
    for (;;) {
      const { data, error: refused } = await supabase.rpc("abo_store_trim_history", {
        p_store: answer.storeId,
        p_batch: TRIM_BATCH,
      });
      if (refused) {
        setRemoving(null);
        setError(`Stopped after removing ${removed.toLocaleString()}: ${refused.message}`);
        return;
      }
      const n = (data as number) ?? 0;
      removed += n;
      setRemoving(removed);
      if (n < TRIM_BATCH) break;
    }
    onDone({ days, from: older.from, extended: older.extended, removed });
  }

  if (error && !answer) {
    return (
      <div className="space-y-3">
        <div className={note.critical}>{error}</div>
        <div className="flex gap-2">
          <button onClick={load} className={button("secondary")}>
            Try again
          </button>
          {onCancel && (
            <button onClick={onCancel} className={button("plain")}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!answer) {
    return (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-control bg-surface-subdued" />
        ))}
      </div>
    );
  }

  // Asked once a shorter window has left orders outside it.
  if (older) {
    return (
      <div className="space-y-4">
        <div className={note.attention}>
          {older.count > 100_000 ? "More than 100,000" : older.count.toLocaleString()} orders here are from before{" "}
          {day(older.from, answer.timezone)}. Keep them, or remove them?
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">
          Kept, they stay as they are and new ones keep arriving. Removed, they go with their lines, payments, refunds
          and shipments; your Shopify store is untouched, and a longer window brings them back.
        </p>
        {error && <div className={note.critical}>{error}</div>}
        {removing !== null ? (
          <div role="status" className="text-[13px] text-fg-muted">
            Removing… {removing.toLocaleString()} so far
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() =>
                onDone({ days: days ?? answer.defaultDays, from: older.from, extended: older.extended, removed: 0 })
              }
              className={button("primary")}
            >
              Keep them
            </button>
            <button onClick={removeOlder} className={button("critical-secondary")}>
              Remove them
            </button>
          </div>
        )}
      </div>
    );
  }

  const chosen = answer.choices.find((c) => c.days === days) ?? null;
  // The whole store fits inside it: worth saying, so a short window does
  // not read as something left behind.
  const coversAll = chosen && answer.firstOrderAt && Date.parse(answer.firstOrderAt) >= Date.parse(chosen.from);
  const locked = answer.choices.some((c) => !c.available);

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="How far back" className="space-y-1.5">
        {answer.choices.map((c) => {
          const on = c.days === days;
          return (
            <button
              key={c.days}
              role="radio"
              aria-checked={on}
              disabled={!c.available}
              onClick={() => setDays(c.days)}
              className={`flex w-full items-center gap-3 rounded-control border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${
                on ? "border-fg bg-surface" : "border-line bg-surface hover:border-line-strong"
              }`}
            >
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  on ? "border-fg bg-primary text-on-primary" : "border-line-strong"
                }`}
              >
                {on && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{windowName(c.days)}</span>
                <span className="block text-xs text-fg-muted">
                  {c.available ? `Since ${day(c.from, answer.timezone)}` : "Needs full order history from Shopify"}
                </span>
              </span>
              {c.available && (
                <span className="shrink-0 text-right text-xs text-fg-muted tabular-nums">
                  <span className="block text-fg">{many(c.orders)} orders</span>
                  <span className="block">{many(c.customers)} customers</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {coversAll && (
        <p className="text-xs text-fg-muted">
          That covers every order: your first was on {day(answer.firstOrderAt as string, answer.timezone)}.
        </p>
      )}
      <p className="text-xs leading-relaxed text-fg-muted">
        Products come in full{answer.products ? ` (${many(answer.products)})` : ""}. New orders and changes keep
        arriving on their own, whatever you choose, and you can change this later in Settings.
      </p>
      {locked && (
        <p className="text-xs leading-relaxed text-fg-faint">
          Shopify shares the last 60 days of orders unless the app has its read_all_orders permission. To go further
          back, add read_all_orders to the app, release it, and connect again.
        </p>
      )}
      {error && <div className={note.critical}>{error}</div>}

      <div className="flex gap-2">
        <button onClick={choose} disabled={busy || days === null} className={button("primary")}>
          {busy ? "Saving…" : (doneLabel ?? `Bring in the ${windowName(days ?? answer.defaultDays).toLowerCase()}`)}
        </button>
        {onCancel && (
          <button onClick={onCancel} className={button("plain")}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
