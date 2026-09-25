"use client";

// One way to show any error — see lib/errors.ts for what one is.
//
// The shape does the work: what happened, why, the raw lines folded
// small, and the ways out as buttons with the best one first. The
// colour says who can fix it, which is the first thing a person wants
// to know: attention is theirs or Luke's, critical is nobody's from here.

import { useState } from "react";
import type { AppError, FixAction } from "@/lib/errors";
import { CircleX, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";

const TONE: Record<AppError["kind"], { box: string; mark: string; Glyph: LucideIcon }> = {
  data: {
    box: "border-tone-attention bg-tone-attention/25 text-tone-attention-fg",
    mark: "text-signal-attention",
    Glyph: Info,
  },
  engine: {
    box: "border-tone-attention bg-tone-attention/25 text-tone-attention-fg",
    mark: "text-signal-attention",
    Glyph: TriangleAlert,
  },
  system: {
    box: "border-tone-critical bg-tone-critical/40 text-tone-critical-fg",
    mark: "text-signal-critical",
    Glyph: CircleX,
  },
};

export default function ErrorNote({
  error,
  onFix,
  compact,
  onDismiss,
}: {
  error: AppError;
  /** Runs one of the ways out. Absent, the buttons are not shown. */
  onFix?: (action: FixAction) => void | Promise<void>;
  /** Inside a list — smaller type, no shadow. */
  compact?: boolean;
  /** Closes it. Absent, there is no close button. */
  onDismiss?: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const tone = TONE[error.kind];
  const fixes = onFix ? (error.fix ?? []) : [];

  return (
    <div
      role="alert"
      className={`rounded-control border px-2.5 py-2 ${compact ? "text-[11px]" : "text-xs"} ${tone.box}`}
    >
      <div className="flex items-start gap-1.5">
        <tone.Glyph aria-hidden size={14} strokeWidth={2} className={`mt-px shrink-0 ${tone.mark}`} />
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="order-last shrink-0 -mt-0.5 -mr-1 rounded px-1 text-[13px] leading-none opacity-50 transition-opacity hover:opacity-100"
          >
            <X aria-hidden size={14} strokeWidth={2} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium break-words">{error.what}</div>
          {error.why && <div className="mt-0.5 opacity-80">{error.why}</div>}
          {error.details && error.details.length > 0 && (
            <ul className={`mt-1 list-disc space-y-0.5 pl-4 opacity-80 ${compact ? "text-[10px]" : "text-[11px]"}`}>
              {error.details.map((d, i) => (
                <li key={i} className="break-words">
                  {d}
                </li>
              ))}
            </ul>
          )}
          {fixes.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {fixes.map((f, i) => (
                <button
                  key={i}
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(i);
                    try {
                      await onFix!(f.action);
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className={
                    f.quiet
                      ? "px-1 py-1 text-[10px] underline decoration-current/40 underline-offset-2 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-50"
                      : i === 0
                        ? "rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-on-primary shadow-control transition-colors hover:bg-primary-hover disabled:opacity-50"
                        : "rounded-md border border-current/25 bg-surface/70 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-surface disabled:opacity-50"
                  }
                >
                  {busy === i ? "…" : f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
