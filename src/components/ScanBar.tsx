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
import type { FeatureSchema, RecordRow } from "@/lib/types";

type Scan = { ok: boolean; message: string };

export default function ScanBar({
  scanMode,
  records,
  onApply,
}: {
  scanMode: NonNullable<FeatureSchema["scanMode"]>;
  records: RecordRow[];
  onApply: (rec: RecordRow, set: Record<string, unknown>) => Promise<void>;
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

  function note(ok: boolean, message: string) {
    setLog((prev) => [{ ok, message }, ...prev].slice(0, 6));
  }

  async function submit() {
    const value = code.trim();
    setCode("");
    if (!value || busy) return;

    const matches = records.filter(
      (r) => String(r.data?.[scanMode.lookupField] ?? "").trim() === value
    );
    if (matches.length === 0) {
      note(false, `No row with ${scanMode.lookupField} “${value}”.`);
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
          note(false, `Out of order: ${value} is #${seq}, you are past #${lastSeq}.`);
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
      note(true, `${value} → ${scanMode.action.label}`);
    } catch (e) {
      note(false, e instanceof Error ? e.message : "That didn't save.");
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
        <ul className="mt-2.5 space-y-1 border-t border-slate-100 pt-2">
          {log.map((s, i) => (
            <li
              key={i}
              className={`text-[11px] ${s.ok ? "text-emerald-700" : "text-rose-700"}`}
            >
              {s.ok ? "✓" : "✕"} {s.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
