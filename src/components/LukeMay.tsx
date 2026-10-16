"use client";

// Settings → Luke (lib/luke-may, 0223): what Luke may do in this app and
// whether he asks first, and the standing yes, a section at a time: rows
// Luke changes without waiting in the bell, taken back with the same
// switch. The owner's alone, as all of Settings is.
//
// Callers: src/components/ProjectSettings.tsx.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { MAY_LABEL, grantedSections, lukeMay, setGrant, type MayRow, type MayState } from "@/lib/luke-may";
import { canCarryOwnFields, isStoreTable } from "@/lib/store-read";
import { hint } from "@/components/ui/controls";
import { Group } from "@/components/ui/Group";
import { Switch } from "@/components/ui/Switch";

const DOT: Record<MayState, string> = {
  on: "bg-signal-success",
  asks: "bg-signal-attention",
  off: "bg-signal-neutral",
  needs: "bg-signal-info",
};

type Section = { id: string; nav_label: string };

export function LukeMay({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<MayRow[] | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [granted, setGranted] = useState<string[]>([]);
  const [shop, setShop] = useState<{ store: boolean; on: boolean; auto: number; watching: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      supabase
        .from("modules")
        .select("id, nav_label, source_table")
        .eq("project_id", projectId)
        .order("sort_order", { ascending: true }),
      grantedSections(supabase, projectId),
      supabase.from("stores").select("status, auto_send").eq("project_id", projectId).limit(1),
      supabase.rpc("abo_store_actions_on", { p_project: projectId }),
      supabase.rpc("abo_alert_settings", { p_project: projectId }),
    ]).then(([mods, g, stores, on, kinds]) => {
      // Only a section whose rows can hold values of theirs: a store list's own columns change in Shopify.
      const changeable = ((mods.data ?? []) as Array<Section & { source_table: string | null }>).filter(
        (m) => !m.source_table || (isStoreTable(m.source_table) && canCarryOwnFields(m.source_table))
      );
      setSections(changeable);
      setGranted(g);
      const store = stores.data?.[0];
      setShop({
        store: store?.status === "connected",
        on: on.data === true,
        auto: ((store?.auto_send as string[] | null) ?? []).length,
        watching: ((kinds.data as Array<{ enabled?: boolean; set?: boolean }> | null) ?? []).filter(
          (k) => k.enabled && k.set !== false
        ).length,
      });
    });
  }, [projectId]);

  useEffect(() => {
    if (!shop) return;
    const names = sections.filter((s) => granted.includes(s.id)).map((s) => s.nav_label);
    setRows(
      lukeMay({ store: shop.store, granted: names, shop: { on: shop.on, auto: shop.auto }, watching: shop.watching })
    );
  }, [shop, sections, granted]);

  const flip = useCallback(
    async (id: string, on: boolean) => {
      setError(null);
      setGranted((g) => (on ? [...g, id] : g.filter((x) => x !== id)));
      const why = await setGrant(supabase, projectId, id, on);
      if (why) {
        setGranted((g) => (on ? g.filter((x) => x !== id) : [...g, id]));
        setError("That didn’t save. Try again.");
      }
    },
    [projectId]
  );

  return (
    <div className="space-y-4">
      <Group title="What Luke may do" description="Each thing Luke can do in this app, and whether he asks you first.">
        {rows === null ? (
          <div className="h-40 animate-pulse rounded bg-surface-hover" aria-busy />
        ) : (
          <ul className="divide-y divide-line" aria-label="What Luke may do">
            {rows.map((r) => (
              <li key={r.what} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">{r.what}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-fg-muted">{r.says}</div>
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[r.state]}`} />
                  {MAY_LABEL[r.state]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group
        title="Change rows without asking"
        description="Let Luke change values in a section’s rows without waiting for your yes. Only when you are the one talking to him; a teammate’s ask and your own AI’s still wait. Turn it off any time."
      >
        {sections.length === 0 ? (
          <p className="text-[13px] text-fg-muted">No section with rows of your own yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {sections.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0 truncate text-[13px] text-fg">{s.nav_label}</span>
                <Switch
                  checked={granted.includes(s.id)}
                  onChange={(on) => void flip(s.id, on)}
                  label={`Luke changes rows in ${s.nav_label} without asking`}
                />
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className={`${hint} text-tone-critical-fg`}>
            {error}
          </p>
        )}
      </Group>
    </div>
  );
}
