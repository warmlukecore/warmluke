"use client";

// ─────────────────────────────────────────────────────────────
// ScanBar — the picking/checking-in workflow. A USB or Bluetooth
// barcode scanner behaves as a keyboard that types the code and
// presses Enter, so a focused input is the whole interface; no
// camera permission, and it works on the cheap handhelds shops
// already own.
//
// sequenceField enforces an order: scanning something whose number
// is lower than the last accepted scan is refused, which is the
// point of a pick sequence.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { evalExpr } from "@/lib/expr";
import { asError, nearest, type AppError, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { FeatureSchema, RecordRow } from "@/lib/types";

type Scan = { ok: true; message: string } | { ok: false; error: AppError };

export default function ScanBar({
  scanMode,
  records,
  onApply,
  onCreate,
}: {
  scanMode: NonNullable<FeatureSchema["scanMode"]>;
  records: RecordRow[];
  onApply: (rec: RecordRow, set: Record<string, unknown>) => Promise<void>;
  /** Makes a row, so a code that is not here yet can be, in one tap. */
  onCreate?: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  // One code can legitimately sit on several rows — the same barcode
  // printed on every colour of a phone case, say. Picking the first
  // match would quietly change the wrong row, so ask instead.
  const [choices, setChoices] = useState<{ code: string; rows: RecordRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Scan[]>([]);
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A scanner types into whatever has focus, so keep the field ready.
  useEffect(() => {
    inputRef.current?.focus();
  }, [log.length]);

  function note(entry: Scan) {
    setLog((prev) => [entry, ...prev].slice(0, 6));
  }
  const ok = (message: string) => note({ ok: true, message });
  const fail = (error: AppError) => note({ ok: false, error });

  /** The two or three things that tell a row apart, for a suggestion. */
  function label(rec: RecordRow): string {
    const parts = Object.entries(rec.data ?? {})
      .filter(([k, v]) => k !== scanMode.lookupField && typeof v === "string" && v.trim())
      .slice(0, 2)
      .map(([, v]) => String(v));
    return parts.join(" · ");
  }

  /**
   * The ways out of a code that matched nothing. Not a dead end: the
   * rows a keystroke away, by name, and a row for this code if it is
   * genuinely new. The merchant chooses; nothing is guessed for them.
   */
  function missed(value: string): AppError {
    const near = nearest(
      value,
      records.map((r) => ({ value: String(r.data?.[scanMode.lookupField] ?? ""), item: r }))
    );
    const fix: AppError["fix"] = near.map((n) => ({
      label: `${n.value}${label(n.item) ? ` — ${label(n.item)}` : ""}`,
      action: { type: "use_value", value: n.value },
    }));
    // Last, and quiet. A row for a code nobody recognised is sometimes
    // what is wanted and usually not — in a packing list it is an item
    // that is not on the order — so it is a link at the end, never the
    // bright button. When nothing is close the honest first move is to
    // look at the code again, and that is what the line says.
    if (onCreate) {
      fix.push({
        label: `Add a row with ${value}`,
        action: { type: "add_row", data: { [scanMode.lookupField]: value } },
        quiet: true,
      });
    }
    return {
      kind: "data",
      what: `No row with ${scanMode.lookupField} “${value}”.`,
      why: near.length
        ? `Did you mean one of these?`
        : records.length
          ? "Check the code — nothing in view is close to it."
          : "There are no rows in view to match against.",
      fix,
    };
  }

  /** The most recent miss, if the top of the log is one. */
  const dismissNewest = () => setLog((prev) => (prev[0] && !prev[0].ok ? prev.slice(1) : prev));

  async function onFix(action: FixAction) {
    if (action.type === "use_value") {
      await submitValue(action.value);
    } else if (action.type === "add_row" && onCreate) {
      try {
        await onCreate(action.data);
        ok(`Added a row with ${String(Object.values(action.data)[0])} — scan it again to apply.`);
      } catch (e) {
        fail(asError(e, "The row could not be added."));
      }
    }
  }

  async function submit() {
    const value = code.trim();
    setCode("");
    await submitValue(value);
  }

  async function submitValue(value: string) {
    if (!value || busy) return;

    const matches = records.filter(
      (r) => String(r.data?.[scanMode.lookupField] ?? "").trim() === value
    );
    if (matches.length === 0) {
      fail(missed(value));
      return;
    }
    if (matches.length > 1) {
      setChoices({ code: value, rows: matches });
      return;
    }
    await apply(matches[0], value);
  }

  async function apply(match: RecordRow, value: string) {
    setChoices(null);

    if (busy) return;
    if (scanMode.sequenceField) {
      const seq = Number(match.data?.[scanMode.sequenceField]);
      if (!Number.isNaN(seq)) {
        if (lastSeq !== null && seq < lastSeq) {
          fail({
            kind: "data",
            what: `Out of order: ${value} is #${seq}, you are past #${lastSeq}.`,
            why: "A pick sequence only moves forward.",
          });
          return;
        }
        setLastSeq(seq);
      }
    }

    setBusy(true);
    try {
      const resolved: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(scanMode.action.set)) {
        resolved[f] = evalExpr(v, { ...(match.data ?? {}), id: match.id });
      }
      await onApply(match, resolved);
      ok(`${value} → ${scanMode.action.label}`);
    } catch (e) {
      fail(asError(e, "That didn't save."));
    } finally {
      setBusy(false);
    }
  }

  /** Whatever tells the candidates apart — the fields where they differ. */
  function describeRow(rec: RecordRow, siblings: RecordRow[]): string {
    const keys = Object.keys(rec.data ?? {}).filter((k) => {
      if (k === scanMode.lookupField) return false;
      const mine = String(rec.data?.[k] ?? "");
      return siblings.some((o) => o !== rec && String(o.data?.[k] ?? "") !== mine);
    });
    const parts = keys.slice(0, 3).map((k) => String(rec.data?.[k] ?? "")).filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "this row";
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-800">
            {scanMode.action.label}
          </div>
          <div className="text-[11px] text-slate-400">
            {scanMode.hint ?? `Scan or type a ${scanMode.lookupField} to apply it.`}
          </div>
        </div>
        {lastSeq !== null && (
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            at #{lastSeq}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex gap-2">
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
          placeholder="Scan here…"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={busy || !code.trim()}
          className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
        >
          {busy ? "…" : "Apply"}
        </button>
      </div>

      {choices && (
        <div className="mt-2.5 rounded-lg border border-blue-200 bg-blue-50/70 p-2.5">
          <div className="text-[11px] font-medium text-blue-900">
            {choices.rows.length} rows share “{choices.code}” — which one?
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {choices.rows.map((r) => (
              <button
                key={r.id}
                disabled={busy}
                onClick={() => apply(r, choices.code)}
                className="rounded-md border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-800 transition-colors hover:bg-blue-100 disabled:opacity-40"
              >
                {describeRow(r, choices.rows)}
              </button>
            ))}
            <button
              onClick={() => setChoices(null)}
              className="rounded-md px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-2.5 border-t border-slate-100 pt-2">
          <ul className="space-y-1">
            {log.map((s, i) =>
              s.ok ? (
                <li key={i} className="text-[11px] text-emerald-700">
                  ✓ {s.message}
                </li>
              ) : i === 0 ? (
                // Only the newest miss is the full note, with its ways
                // out and a way to close it. Older misses are history:
                // one line each, no buttons — a stale "use 12354" under
                // a fresh scan would apply to the wrong moment, and
                // three amber boxes stacked up were a wall.
                <li key={i}>
                  <ErrorNote error={s.error} compact onFix={onFix} onDismiss={dismissNewest} />
                </li>
              ) : (
                <li key={i} className="text-[11px] text-rose-700">
                  ✕ {s.error.what}
                </li>
              )
            )}
          </ul>
          <button
            onClick={() => setLog([])}
            className="mt-1.5 text-[10px] text-slate-400 underline decoration-slate-300 underline-offset-2 hover:text-slate-600"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
