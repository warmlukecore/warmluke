"use client";

// ─────────────────────────────────────────────────────────────
// Data & privacy — how long the console keeps what Luke did (0159).
//
// Every turn leaves a trace: its steps, tokens, dollars and what went
// wrong. They are how a reported conversation is understood, so they are
// kept until an administrator decides otherwise: switched on, a nightly
// job deletes traces older than the kept days. Only traces; messages,
// records and the audit trail are never deleted here. Spend reads the
// traces, so it reaches back only as far as they are kept.
//
// Everything goes through functions that refuse anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { PageFrame } from "@/components/PageFrame";
import { adminError } from "@/components/AdminParts";
import { button, card, field, label, note } from "@/components/ui/controls";
import { Switch } from "@/components/ui/Switch";

type Retention = {
  enabled: boolean;
  days: number;
  last_run_at: string | null;
  last_deleted: number | null;
  updated_at: string;
  updated_by: string | null;
  past: number;
  oldest: string | null;
  bytes: number;
  scheduled: boolean;
};

const megabytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const many = (n: number) => (n > 100_000 ? "Over 100,000" : n.toLocaleString());

export default function Privacy() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<Retention | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState<{ on: "save" | "sweep"; ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  const shown = useCallback((row: Retention) => {
    setR(row);
    setEnabled(row.enabled);
    setDays(String(row.days));
    setNow(Date.now());
  }, []);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_retention");
    if (err) {
      setError(adminError(err, "0159"));
      return;
    }
    setError(null);
    shown(data as Retention);
  }, [shown]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 7 && n <= 3650;
  const dirty = !!r && (enabled !== r.enabled || n !== r.days);

  async function save() {
    setBusy(true);
    setSaid(null);
    const { data, error: err } = await supabase.rpc("abo_admin_set_retention", { p_enabled: enabled, p_days: n });
    setBusy(false);
    if (err) {
      setSaid({ on: "save", ok: false, text: err.message });
      return;
    }
    shown(data as Retention);
    setSaid({
      on: "save",
      ok: true,
      text: enabled ? `Saved. Each night, traces older than ${n} days are deleted.` : "Saved. Every trace is kept.",
    });
  }

  async function sweep() {
    setConfirming(false);
    setBusy(true);
    setSaid(null);
    const { data, error: err } = await supabase.rpc("abo_admin_sweep_traces");
    setBusy(false);
    if (err) {
      setSaid({ on: "sweep", ok: false, text: err.message });
      return;
    }
    const out = data as { deleted: number; more: boolean };
    setSaid({
      on: "sweep",
      ok: true,
      text: `Deleted ${out.deleted.toLocaleString()} ${out.deleted === 1 ? "trace" : "traces"}.${
        out.more ? " More are left: press it again." : ""
      }`,
    });
    await load();
  }

  if (loading || !user || (!r && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-40 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Data &amp; privacy</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          How long the record of what Luke did is kept. Messages, records and the audit trail are never deleted here.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {r && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["Room they take", megabytes(r.bytes), "traces and their indexes"],
                  [
                    "Oldest",
                    r.oldest ? ago(r.oldest, now) : "None yet",
                    r.oldest ? new Date(r.oldest).toLocaleDateString() : "",
                  ],
                  [`Older than ${r.days} days`, many(r.past), r.past ? "would go tonight" : "nothing to delete"],
                  [
                    "Last clean-up",
                    r.last_run_at ? ago(r.last_run_at, now) : "Never",
                    r.last_run_at ? `${(r.last_deleted ?? 0).toLocaleString()} deleted` : "",
                  ],
                ] as const
              ).map(([name, value, sub]) => (
                <div key={name} className={`${card} p-4`}>
                  <div className="text-xs text-fg-muted">{name}</div>
                  <div className="mt-1 text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
                  <div className="mt-0.5 text-xs text-fg-faint">{sub}</div>
                </div>
              ))}
            </div>

            <div className={`${card} mt-4 p-5`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[13px] font-medium text-fg">Delete old traces each night</div>
                  <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-fg-muted">
                    {enabled
                      ? "On: every night, traces older than the days below are deleted. Spend then reaches back only that far."
                      : "Off: every trace is kept, and Spend reaches back to the first one."}
                  </p>
                </div>
                <Switch checked={enabled} onChange={setEnabled} label="Delete old traces each night" />
              </div>
              <div className="mt-4 max-w-[12rem]">
                <label htmlFor="retention-days" className={label}>
                  Keep traces for (days)
                </label>
                <input
                  id="retention-days"
                  type="number"
                  inputMode="numeric"
                  min={7}
                  max={3650}
                  aria-invalid={!valid}
                  className={field}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
                {!valid && <p className="mt-1 text-xs text-tone-critical-fg">From 7 to 3650 days.</p>}
              </div>
              {!r.scheduled && (
                <p className={`${note.attention} mt-4`}>
                  This database has no scheduler (pg_cron), so nothing runs by itself here. The button below still does.
                </p>
              )}
              {r.updated_by && (
                <p className="mt-4 text-xs text-fg-faint">
                  Last changed by {r.updated_by}, {ago(r.updated_at, now)}.
                </p>
              )}
              {said?.on === "save" && (
                <div role="status" className={`${said.ok ? note.success : note.critical} mt-4 text-[13px]`}>
                  {said.text}
                </div>
              )}
              <div className="mt-4 flex justify-end">
                <button onClick={save} disabled={!dirty || !valid || busy} className={button("primary", "sm")}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            <div className={`${card} mt-4 p-5`}>
              <div className="text-[13px] font-medium text-fg">Delete them now</div>
              <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-fg-muted">
                Deletes traces older than {r.days} days now, whether the nightly clean-up is on or not. A deleted trace
                cannot be brought back.
              </p>
              {said?.on === "sweep" && (
                <div role="status" className={`${said.ok ? note.success : note.critical} mt-4 text-[13px]`}>
                  {said.text}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                {confirming ? (
                  <>
                    <span className="mr-auto text-[13px] text-fg">
                      Delete {many(r.past).toLowerCase()} {r.past === 1 ? "trace" : "traces"} older than {r.days} days?
                    </span>
                    <button onClick={() => setConfirming(false)} className={button("secondary", "sm")}>
                      Cancel
                    </button>
                    <button onClick={sweep} className={button("critical", "sm")}>
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={busy || r.past === 0}
                    className={button("secondary", "sm")}
                  >
                    {busy ? "Deleting…" : "Delete older now"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}
