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
//
// first opens a group before the items: the order's label, then the
// SKUs in that order, in the same one input. The group's rows are read
// from the database by the code (onOpenGroup), shown alone, and matched
// alone; once every one of them is done, the bar says so and goes back
// to the first scan by itself, so the packer's hands never leave the
// scanner. A label scanned while a group is open opens that one.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { evalExpr, truthy } from "@/lib/expr";
import { groupDone, rowsFor, sameCode } from "@/lib/scan";
import { asError, nearest, type AppError, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { FeatureSchema, RecordRow, SchemaColumn } from "@/lib/types";
import { fieldText } from "@/components/views";
import { useLinkLabel } from "@/components/LinkContext";
import { useFormat } from "@/lib/format";
import { isId } from "@/lib/no-ids";
import { Check, CircleX, X } from "lucide-react";

type Scan = { ok: true; message: string } | { ok: false; error: AppError };

export default function ScanBar({
  scanMode,
  columns,
  records,
  onApply,
  onCreate,
  group = null,
  onGroup,
  onOpenGroup,
}: {
  scanMode: NonNullable<FeatureSchema["scanMode"]>;
  /** The section's columns, so a row is told apart by what it shows, not by its ids. */
  columns: SchemaColumn[];
  records: RecordRow[];
  onApply: (rec: RecordRow, set: Record<string, unknown>) => Promise<void>;
  /** Makes a row, so a code that is not here yet can be, in one tap. */
  onCreate?: (data: Record<string, unknown>) => Promise<void>;
  /** The group open now (scanMode.first), by its code; `records` are then its rows alone. */
  group?: string | null;
  onGroup?: (code: string | null) => void;
  /** Reads a group's rows into the section by its code, wherever they are; how many there are. */
  onOpenGroup?: (field: string, code: string) => Promise<RecordRow[]>;
}) {
  const [code, setCode] = useState("");
  // One code can legitimately sit on several rows — the same barcode
  // printed on every colour of a phone case, say. Picking the first
  // match would quietly change the wrong row, so ask instead.
  const [choices, setChoices] = useState<{ code: string; rows: RecordRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Scan[]>([]);
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  // Whether an item was scanned in the group open now: a group done
  // without one was done before it was opened.
  const [scanned, setScanned] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const first = scanMode.first && onGroup ? scanMode.first : null;
  const matchFields = [scanMode.lookupField, ...(scanMode.alsoMatch ?? [])];

  // A scanner types into whatever has focus, so keep the field ready.
  useEffect(() => {
    inputRef.current?.focus();
  }, [log.length]);

  function note(entry: Scan) {
    setLog((prev) => [entry, ...prev].slice(0, 6));
  }
  const ok = (message: string) => note({ ok: true, message });
  const fail = (error: AppError) => note({ ok: false, error });

  const fmt = useFormat();
  const linkLabel = useLinkLabel();
  // What a row shows, column by column: a link as the row it points at,
  // a number as a number. A value that is only an id is nothing to a
  // person — "which one?" once offered two rows as four uuids each.
  const fields = columns.filter((c) => !matchFields.includes(c.field)).map((c) => c.field);
  const shown = (rec: RecordRow, field: string) => {
    const text = fieldText(fmt, columns, rec, field, linkLabel);
    return text && text !== "(deleted)" && !isId(text) ? text : "";
  };

  /** The two or three things that tell a row apart, for a suggestion. */
  function label(rec: RecordRow): string {
    return fields
      .map((f) => shown(rec, f))
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
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
        action: {
          type: "add_row",
          data: { [scanMode.lookupField]: value, ...(first && group ? { [first.field]: group } : {}) },
        },
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

  /**
   * Opens the group a code names: its rows read in from the database,
   * shown alone. False when the code names none.
   */
  async function open(code: string): Promise<boolean> {
    if (!first || !onGroup) return false;
    setBusy(true);
    try {
      const n = onOpenGroup
        ? (await onOpenGroup(first.field, code)).length
        : records.filter((r) => sameCode(r.data?.[first.field], code)).length;
      if (!n) return false;
      const was = group;
      onGroup(code);
      setScanned(false);
      setLastSeq(null);
      ok(`${was ? `${was} left open. ` : ""}Opened ${code}: ${n} line${n === 1 ? "" : "s"}. Scan the items.`);
      return true;
    } catch (e) {
      fail(asError(e, "That code could not be looked up."));
      return true;
    } finally {
      setBusy(false);
    }
  }

  // Every row of the open group done: said, and the bar is back at its
  // first scan for the next one, with no tap.
  useEffect(() => {
    if (!first || !group || !scanMode.done || busy || !groupDone(records, scanMode.done)) return;
    ok(
      scanned ? `${group} is done: every line checks out. Scan the next.` : `${group} was already done. Scan the next.`
    );
    setScanned(false);
    onGroup?.(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [records, group, busy]);

  async function submitValue(value: string) {
    if (!value || busy) return;

    // The first scan opens a group; nothing else is matched until one is.
    if (first && !group) {
      if (!(await open(value))) {
        fail({
          kind: "data",
          what: `Nothing with ${first.field} “${value}”.`,
          why: "Check the label, or whether it has come in yet.",
        });
      }
      return;
    }

    const matches = rowsFor(records, value, matchFields);
    if (matches.length === 0) {
      // Another group's label while one is open: the packer moved on.
      if (first && !sameCode(value, group) && (await open(value))) return;
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
        resolved[f] = evalExpr(v, { ...match.data, id: match.id });
      }
      await onApply(match, resolved);
      setScanned(true);
      ok(`${value} → ${scanMode.action.label}`);
    } catch (e) {
      fail(asError(e, "That didn't save."));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Whatever tells the candidates apart — the fields where they differ,
   * as they read on screen. Rows alike in all of those are numbered.
   */
  function describeRow(rec: RecordRow, siblings: RecordRow[]): string {
    const parts = fields
      .filter((f) => siblings.some((o) => o !== rec && shown(o, f) !== shown(rec, f)))
      .map((f) => shown(rec, f))
      .filter(Boolean)
      .slice(0, 3);
    return parts.length > 0 ? parts.join(" · ") : `Row ${siblings.indexOf(rec) + 1} of ${siblings.length}`;
  }

  const doneCount =
    first && group && scanMode.done
      ? records.filter((r) => truthy(evalExpr(scanMode.done, { ...r.data, id: r.id }))).length
      : null;
  const title = !first
    ? scanMode.action.label
    : group
      ? `${group} · ${doneCount !== null ? `${doneCount} of ${records.length} done` : `${records.length} lines`}`
      : (first.label ?? `Scan the ${first.field}`);

  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-fg">{title}</div>
          <div className="text-[11px] text-fg-faint">
            {first && group
              ? `${scanMode.action.label}: scan each item.`
              : (scanMode.hint ?? `Scan or type a ${scanMode.lookupField} to apply it.`)}
          </div>
        </div>
        {first && group && (
          <button
            type="button"
            onClick={() => {
              onGroup?.(null);
              setScanned(false);
            }}
            aria-label={`Close ${group}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover"
          >
            <X aria-hidden size={13} strokeWidth={2} />
            Close
          </button>
        )}
        {lastSeq !== null && (
          <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-semibold text-fg-muted">
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
          placeholder={first ? (group ? "Scan an item…" : "Scan the label…") : "Scan here…"}
          className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={busy || !code.trim()}
          className="rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {busy ? "…" : "Apply"}
        </button>
      </div>

      {choices && (
        <div className="mt-2.5 rounded-lg border border-tone-info bg-tone-info/50 p-2.5">
          <div className="text-[11px] font-medium text-tone-info-fg">
            {choices.rows.length} rows share “{choices.code}” — which one?
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {choices.rows.map((r) => (
              <button
                key={r.id}
                disabled={busy}
                onClick={() => apply(r, choices.code)}
                className="rounded-md border border-tone-info bg-surface px-2 py-1 text-[11px] font-medium text-tone-info-fg transition-colors hover:bg-tone-info disabled:opacity-40"
              >
                {describeRow(r, choices.rows)}
              </button>
            ))}
            <button
              onClick={() => setChoices(null)}
              className="rounded-md px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-surface"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-2.5 border-t border-line pt-2">
          <ul className="space-y-1">
            {log.map((s, i) =>
              s.ok ? (
                <li key={i} className="text-[11px] text-tone-success-fg">
                  <Check aria-hidden size={14} strokeWidth={2.25} className="mr-1 inline align-[-2px]" />
                  {s.message}
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
                <li key={i} className="text-[11px] text-tone-critical-fg">
                  <CircleX aria-hidden size={14} strokeWidth={2} className="mr-1 inline align-[-2px]" />
                  {s.error.what}
                </li>
              )
            )}
          </ul>
          <button
            onClick={() => setLog([])}
            className="mt-1.5 text-[10px] text-fg-faint underline decoration-line-strong underline-offset-2 hover:text-fg-muted"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
