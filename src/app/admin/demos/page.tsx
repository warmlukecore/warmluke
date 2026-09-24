"use client";

// ─────────────────────────────────────────────────────────────
// Everybody who asked for a demo, newest first.
//
// Read through abo_admin_demo_requests (0115), which refuses anyone
// who is not an administrator, the same door as the accounts screen.
// The rows were typed by strangers, and not necessarily through the
// form, so every value is shown as text: a list value this screen does
// not know is shown as it is, and a store is only a link when it is a
// plain https address.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Breakdown, Stat, siteLink, topCounts } from "@/components/AdminParts";
import { card, field, note } from "@/components/ui/controls";
import { quietClasses } from "@/lib/tone";
import { HEARD_OPTIONS, ORDER_OPTIONS, TEAM_OPTIONS, labelOf } from "@/lib/onboarding";
import { ago } from "@/lib/when";

type Lead = {
  id: string;
  created_at: string;
  name: string | null;
  email: string | null;
  store: string | null;
  note: string | null;
  team_size: string | null;
  monthly_orders: string | null;
  heard_from: string | null;
  heard_from_detail: string | null;
  variant: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  has_account: boolean;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Who a request is from: the address, or the row itself when there is none. */
const who = (r: Lead) => (r.email ?? "").trim().toLowerCase() || r.id;

export default function DemoRequests() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace("/login?next=/admin/demos");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    supabase.rpc("abo_admin_demo_requests").then(({ data, error: err }) => {
      if (err) {
        setError(
          err.code === "42501"
            ? "This page is for administrators."
            : // A deployment that is ahead of its database.
              err.code === "PGRST202"
              ? "This database does not have demo requests yet: apply migration 0115."
              : err.message
        );
        setRows([]);
        return;
      }
      setError(null);
      setRows((data ?? []) as Lead[]);
    });
  }, [user]);

  // Somebody who asked twice is one person, and worth knowing about.
  const times = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(who(r), (m.get(who(r)) ?? 0) + 1);
    return m;
  }, [rows]);

  const stats = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      people: times.size,
      thisWeek: all.filter((r) => now - Date.parse(r.created_at) < WEEK_MS).length,
      signedUp: all.filter((r) => r.has_account).length,
      heard: topCounts(all.map((r) => labelOf(HEARD_OPTIONS, r.heard_from))),
      orders: topCounts(all.map((r) => labelOf(ORDER_OPTIONS, r.monthly_orders))),
    };
  }, [rows, times, now]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => !q || [r.name, r.email, r.store].some((v) => (v ?? "").toLowerCase().includes(q))
      ),
    [rows, q]
  );

  if (loading || !user || rows === null) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-40 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
          <div className="mt-6 h-64 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame email={user.email} isSuperadmin={!error}>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Demo requests</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          Everyone who asked for a demo on the website, what they told us, and what sent them.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {!error && rows.length === 0 && <p className="mt-6 text-[13px] text-fg-muted">No demo requests yet.</p>}

        {rows.length > 0 && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Requests"
                value={stats.total}
                sub={`${stats.thisWeek} this week${stats.people < stats.total ? `, from ${stats.people} people` : ""}`}
              />
              <Stat label="Already have an account" value={stats.signedUp} sub={`of ${stats.total}`} />
              <Breakdown label="Where they heard of us" counts={stats.heard} empty="Nobody has said yet" />
              <Breakdown label="Orders a month" counts={stats.orders} empty="Nobody has said yet" />
            </div>

            <label className="relative mt-6 block max-w-xs">
              <Search aria-hidden size={15} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="Find by name, email or store"
                aria-label="Find a demo request"
                className={`${field} pl-8`}
              />
            </label>

            <div className={`${card} thin-scroll mt-3 overflow-x-auto`}>
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-surface-subdued text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Who</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Business</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Heard of us</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">Came from</th>
                    <th className="px-3 py-2.5 font-medium first:pl-4">What Luke should fix first</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((r) => {
                    const site = siteLink(r.store);
                    const asked = times.get(who(r)) ?? 1;
                    // Bookings from before these were asked have none of them.
                    const facts = [
                      r.team_size ? `team ${labelOf(TEAM_OPTIONS, r.team_size)}` : null,
                      r.monthly_orders === "undisclosed"
                        ? "orders not said"
                        : r.monthly_orders
                          ? `${labelOf(ORDER_OPTIONS, r.monthly_orders)} orders/mo`
                          : null,
                    ].filter(Boolean);
                    const source = [r.utm_source, r.utm_medium].filter(Boolean).join(" / ");
                    return (
                      <tr key={r.id} className="align-top transition-colors hover:bg-surface-subdued/60">
                        <td className="px-3 py-3 first:pl-4">
                          <div className="flex items-start gap-2.5">
                            <span
                              aria-hidden
                              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${quietClasses(who(r))}`}
                            >
                              {(r.name || r.email || "?").trim().charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="max-w-[14rem] truncate font-medium text-fg">{r.name || "No name given"}</span>
                                {r.has_account && (
                                  <span className="rounded-full bg-tone-success px-1.5 py-px text-[10px] font-medium whitespace-nowrap text-tone-success-fg">
                                    has an account
                                  </span>
                                )}
                                {asked > 1 && (
                                  <span className="rounded-full bg-tone-attention px-1.5 py-px text-[10px] font-medium whitespace-nowrap text-tone-attention-fg">
                                    asked {asked} times
                                  </span>
                                )}
                              </div>
                              {r.email && (
                                <a href={`mailto:${r.email}`} className="block max-w-[14rem] truncate text-xs text-link hover:underline">
                                  {r.email}
                                </a>
                              )}
                              <div className="text-[11px] whitespace-nowrap text-fg-faint" title={new Date(r.created_at).toLocaleString()}>
                                {new Date(r.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                                {" · "}
                                {ago(r.created_at, now)}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 first:pl-4">
                          <div className="min-w-44 max-w-60">
                            {site ? (
                              <a href={site.href} target="_blank" rel="noopener noreferrer nofollow" className="block truncate font-medium text-link hover:underline">
                                {site.text}
                              </a>
                            ) : (
                              <div className="truncate font-medium text-fg">{r.store || "No store given"}</div>
                            )}
                            {facts.length > 0 ? (
                              <div className="text-xs text-fg-muted">{facts.join(" · ")}</div>
                            ) : (
                              <div className="text-xs text-fg-faint">Size not asked</div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 first:pl-4">
                          {r.heard_from ? (
                            <div className="min-w-32 max-w-48">
                              <div className="text-fg">{labelOf(HEARD_OPTIONS, r.heard_from)}</div>
                              {r.heard_from_detail && <div className="text-xs break-words text-fg-muted">{r.heard_from_detail}</div>}
                            </div>
                          ) : (
                            <span className="text-xs text-fg-faint">Not asked</span>
                          )}
                        </td>
                        <td className="px-3 py-3 first:pl-4">
                          <div className="min-w-36 max-w-56 text-xs">
                            <div className="text-fg">{source || "Direct"}</div>
                            {r.utm_campaign && <div className="truncate text-fg-muted" title={r.utm_campaign}>{r.utm_campaign}</div>}
                            {r.variant && <div className="text-fg-faint">saw the {r.variant} hero</div>}
                          </div>
                        </td>
                        <td className="px-3 py-3 first:pl-4">
                          {r.note ? (
                            <p className="max-w-sm min-w-56 whitespace-pre-line break-words text-fg">{r.note}</p>
                          ) : (
                            <span className="text-xs text-fg-faint">Nothing written</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-[13px] text-fg-muted">
                        No request matches &ldquo;{query}&rdquo;.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}
