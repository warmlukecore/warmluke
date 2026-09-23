"use client";

// ─────────────────────────────────────────────────────────────
// StoreSwitcher — every store the merchant can open, from any of them.
//
// A store is its own project: its data, sections, rules and chat, kept
// apart from every other store's. A merchant with three shops has three,
// and this is how they move between them without going back to the
// dashboard — and how they add a fourth.
//
// The list is read from the database each time it is opened, under the
// same policies as everything else, so it is never a list somebody
// wrote down: it is what they can open, and how each store stands now.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";
import { storeStanding, type Standing } from "@/lib/store-standing";
import { canOneTap } from "@/lib/one-tap";

type Row = {
  id: string;
  name: string;
  stores: Array<{
    shop_domain: string;
    status: string;
    connected_at: string | null;
    token_expires_at: string | null;
    refresh_token_expires_at: string | null;
    import_runs: Array<{ status: string }> | null;
  }> | null;
};

type Entry = { projectId: string; projectName: string; shop: string; standing: Standing };

/** Past this many, a search box is quicker than scrolling. */
const SEARCH_FROM = 7;

const DOT: Record<Standing["tone"], string> = {
  ok: "bg-emerald-500",
  busy: "bg-sky-500",
  warn: "bg-amber-500",
};

const handle = (shop: string) => shop.replace(/\.myshopify\.com$/, "");

export default function StoreSwitcher({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [oneTap, setOneTap] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("projects")
      .select(
        "id, name, stores(shop_domain, status, connected_at, token_expires_at, refresh_token_expires_at, import_runs(status))"
      )
      .order("created_at", { ascending: true });
    // A list that failed to load is not a list of nothing: keep what was
    // shown rather than tell them their stores are gone.
    if (error) return;
    const next: Entry[] = [];
    for (const p of (data ?? []) as Row[]) {
      for (const s of p.stores ?? []) {
        // An attempt that never came back from Shopify is not a store
        // anyone can open; the dashboard shows it, this does not.
        if (s.status === "pending" && !s.connected_at) continue;
        const runs = s.import_runs ?? [];
        next.push({
          projectId: p.id,
          projectName: p.name,
          shop: s.shop_domain,
          standing: storeStanding({ ...s, importing: runs.length === 0 || runs.some((r) => r.status !== "done") }),
        });
      }
    }
    setEntries(next);
  }, []);

  useEffect(() => {
    load();
    canOneTap().then(setOneTap);
  }, [load]);

  // Fresh each time it is opened: a store connected in another tab, or
  // one whose import finished, is shown as it is now.
  useEffect(() => {
    if (!open) return;
    load();
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, load]);

  const current = entries?.find((e) => e.projectId === projectId) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!entries || !q) return entries ?? [];
    return entries.filter((e) => e.shop.toLowerCase().includes(q) || e.projectName.toLowerCase().includes(q));
  }, [entries, query]);

  // No store anywhere: connecting one is the store strip's job, and a
  // switcher with nothing to switch between is only clutter.
  if (!entries || entries.length === 0) return null;

  // "+ Connect another store": through Shopify with a hint for a new
  // project, made only once Shopify has named the store. Without one
  // tap here, the dashboard is where a project and its store are added.
  const another = oneTap ? "/api/shopify/start?project=new" : "/dashboard";

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? `${current.shop} — ${current.standing.label}` : "Switch store"}
        className="flex max-w-[11rem] items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 sm:max-w-[16rem]"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${current ? DOT[current.standing.tone] : "bg-slate-300"}`} />
        <span className="truncate">{current ? handle(current.shop) : "No store"}</span>
        <span className="text-slate-400" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-lg"
        >
          {entries.length >= SEARCH_FROM && (
            <div className="border-b border-slate-100 p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a store"
                aria-label="Find a store"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-blue-400"
              />
            </div>
          )}
          <div className="max-h-80 overflow-y-auto py-1">
            {shown.map((e) => {
              const here = e.projectId === projectId;
              const named = e.projectName !== handle(e.shop);
              return (
                <Link
                  key={`${e.projectId}:${e.shop}`}
                  role="menuitem"
                  href={`/app/${e.projectId}`}
                  onClick={() => setOpen(false)}
                  aria-current={here ? "true" : undefined}
                  className={`flex items-start gap-2 px-3 py-2 transition-colors hover:bg-slate-50 ${here ? "bg-slate-50" : ""}`}
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[e.standing.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-800">{e.shop}</span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {named ? `${e.projectName} · ` : ""}
                      {e.standing.label}
                      {e.standing.reconnect ? " — open it to reconnect" : ""}
                    </span>
                  </span>
                  {here && (
                    <span className="mt-0.5 text-xs text-blue-600" aria-hidden>
                      ✓
                    </span>
                  )}
                </Link>
              );
            })}
            {shown.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No store matches that.</p>}
          </div>
          <a
            href={another}
            role="menuitem"
            className="block border-t border-slate-100 px-3 py-2 text-xs font-medium text-blue-600 transition-colors hover:bg-slate-50"
          >
            + Connect another store
          </a>
        </div>
      )}
    </div>
  );
}
