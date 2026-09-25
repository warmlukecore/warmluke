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
import { menu, menuItem, fieldOf } from "@/components/ui/controls";
import { quietClasses } from "@/lib/tone";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

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
  ok: "bg-signal-success",
  busy: "bg-signal-info",
  warn: "bg-signal-attention",
};

const handle = (shop: string) => shop.replace(/\.myshopify\.com$/, "");

export default function StoreSwitcher({
  projectId,
  // Where it sits: the header, or the foot of the dark sidebar, where
  // it opens upward.
  placement = "header",
}: {
  projectId: string;
  placement?: "header" | "sidebar";
}) {
  const inSidebar = placement === "sidebar";
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
          // Importing while a list has not started or is under way; a list
          // that stopped is not importing, and the store's own line says so.
          standing: storeStanding({
            ...s,
            importing: runs.length === 0 || runs.some((r) => r.status !== "done" && r.status !== "failed"),
          }),
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
        className={
          inSidebar
            ? `flex w-full items-center gap-2 rounded-control px-1.5 py-1.5 text-[13px] text-frame-fg transition-colors hover:bg-frame-raised ${open ? "bg-frame-raised" : ""}`
            : "flex max-w-[11rem] items-center gap-1.5 rounded-control bg-surface px-2.5 py-1.5 text-[13px] text-fg shadow-control transition-colors hover:bg-surface-hover sm:max-w-[16rem]"
        }
      >
        {current ? (
          <StoreTile shop={current.shop} tone={current.standing.tone} onFrame={inSidebar} />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-neutral" />
        )}
        <span className={`truncate ${inSidebar ? "flex-1 text-left font-medium" : ""}`}>
          {current ? handle(current.shop) : "No store"}
        </span>
        <ChevronsUpDown
          aria-hidden
          size={14}
          strokeWidth={1.75}
          className={inSidebar ? "text-frame-fg-muted" : "text-fg-faint"}
        />
      </button>

      {open && (
        <div
          role="menu"
          style={inSidebar ? { ["--pop-from" as string]: "4px" } : undefined}
          className={`${menu} absolute ${inSidebar ? "right-0 bottom-full left-0 mb-1.5 min-w-56" : "right-0 mt-1.5 w-72"}`}
        >
          {entries.length >= SEARCH_FROM && (
            <div className="p-1 pb-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a store"
                aria-label="Find a store"
                className={`${fieldOf("sm")} w-full`}
              />
            </div>
          )}
          <div className="thin-scroll max-h-72 overflow-y-auto">
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
                  className={`${menuItem} ${here ? "bg-surface-subdued" : ""}`}
                >
                  <StoreTile shop={e.shop} tone={e.standing.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-fg">{handle(e.shop)}</span>
                    <span className="block truncate text-[11px] text-fg-muted">
                      {named ? `${e.projectName} · ` : ""}
                      {e.standing.label}
                      {e.standing.reconnect ? " — open it to reconnect" : ""}
                    </span>
                  </span>
                  {here && <Check aria-hidden size={15} strokeWidth={2} className="shrink-0 text-fg" />}
                </Link>
              );
            })}
            {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-fg-faint">No store matches that.</p>}
          </div>
          <div className="my-1 h-px bg-line" />
          <a href={another} role="menuitem" className={`${menuItem} text-fg-muted hover:text-fg`}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border border-dashed border-line-strong">
              <Plus aria-hidden size={13} strokeWidth={2} />
            </span>
            Connect another store
          </a>
        </div>
      )}
    </div>
  );
}

/** A store's first letter on its own calm colour, with how it stands in the corner. */
function StoreTile({ shop, tone, onFrame = false }: { shop: string; tone: Standing["tone"]; onFrame?: boolean }) {
  return (
    <span className="relative shrink-0">
      <span
        aria-hidden
        className={`flex h-6 w-6 items-center justify-center rounded-[6px] text-[11px] font-semibold ${quietClasses(shop)}`}
      >
        {handle(shop).charAt(0).toUpperCase()}
      </span>
      <span
        className={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ${onFrame ? "ring-frame" : "ring-surface"} ${DOT[tone]}`}
      />
    </span>
  );
}
