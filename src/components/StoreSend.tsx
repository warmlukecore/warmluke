"use client";

// What the owner sends straight to their Shopify store (0195, Tanish,
// 7 Oct): one switch per kind of change Warmluke can make there, read
// off the registry (lib/store-actions), so a change added later is here
// without a line of its own. Off until the owner turns it on; turning it
// on shows what it means, in the words kept with their yes. What Luke,
// their own AI or a teammate asks for waits for the owner's yes whatever
// these say, and the screen says so.
//
// Callers: src/components/ProjectSettings.tsx (the Store tab).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { Dialog } from "@/components/ui/Dialog";
import { Group } from "@/components/ui/Group";
import { Switch } from "@/components/ui/Switch";
import { button, note } from "@/components/ui/controls";
import { ACTIONS, STORE_ACTIONS, actionsFor, sendNowSaid } from "@/lib/store-actions";
import { STORE_TABLES, type StoreTable } from "@/lib/store-read";
import { hasScope } from "@/lib/shopify-resources";

export type SendStore = {
  id: string;
  shop_domain: string;
  granted_scopes: string[] | null;
  auto_send: string[] | null;
};

/** The lists a change can be made from, by the names the menu gives them. */
const LISTS = Object.fromEntries(
  ACTIONS.map((a) => [
    a,
    (Object.keys(STORE_TABLES) as StoreTable[])
      .filter((t) => actionsFor(STORE_TABLES[t].gives).includes(a))
      .map((t) => STORE_TABLES[t].section.label),
  ])
);

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function StoreSend({
  projectId,
  store,
  onChanged,
}: {
  projectId: string;
  store: SendStore;
  onChanged: () => void;
}) {
  // Whether the account may change a store at all (0107): an administrator's switch.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [on, setOn] = useState<string[]>(store.auto_send ?? []);
  const [since, setSince] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: may }, { data: kept }] = await Promise.all([
      supabase.rpc("abo_store_actions_on", { p_project: projectId }),
      supabase
        .from("store_send_consents")
        .select("action, turned_on, created_at")
        .eq("store_id", store.id)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    setAllowed(may === true);
    // When each was last turned on, the newest of its rows.
    const last: Record<string, string> = {};
    for (const c of (kept ?? []) as Array<{ action: string; turned_on: boolean; created_at: string }>)
      if (!(c.action in last)) last[c.action] = c.turned_on ? c.created_at : "";
    setSince(last);
  }, [projectId, store.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setOn(store.auto_send ?? []), [store.auto_send]);

  const set = async (action: string, next: boolean) => {
    setBusy(action);
    setError(null);
    const { data, error: e } = await supabase.rpc("abo_set_auto_send", {
      p_store: store.id,
      p_action: action,
      p_on: next,
      p_said: next ? sendNowSaid(STORE_ACTIONS[action], store.shop_domain) : "",
    });
    setBusy(null);
    if (e) return setError(e.message);
    setOn((data as string[] | null) ?? []);
    setAsking(null);
    await load();
    onChanged();
  };

  const granted = store.granted_scopes;
  const asked = asking ? STORE_ACTIONS[asking] : null;

  return (
    <Group
      title="Changes to your Shopify store"
      description="Tick rows on a list to change them in Shopify. Each kind waits in the bell for your yes until you let it go straight to Shopify here. What Luke or your own AI asks for, and what your teammates change, always waits for your yes."
    >
      {allowed === false && (
        <div className={note.info}>
          Changing your Shopify store from Warmluke is not turned on for this account yet. Warmluke turns it on when you
          ask.
        </div>
      )}
      {error && <div className={note.critical}>{error}</div>}
      <ul className="-my-2 divide-y divide-line">
        {ACTIONS.map((a) => {
          const spec = STORE_ACTIONS[a];
          const isOn = on.includes(a);
          // Null: nobody has looked at what the store allowed since it was granted, and the run finds out.
          const short = granted ? spec.scopes.filter((s) => !hasScope(granted, s)) : [];
          const blocked = allowed === false || short.length > 0;
          return (
            <li key={a} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="text-[13px] text-fg">
                  {spec.label}
                  {LISTS[a].length > 0 && <span className="text-fg-muted"> · {LISTS[a].join(", ")}</span>}
                </div>
                <div className="mt-0.5 text-xs text-fg-muted">
                  {isOn
                    ? `Goes straight to Shopify${since[a] ? `, on since ${day(since[a])}` : ""}. Change it on the list: press Edit and type into the cell, or tick rows.`
                    : "Waits in the bell for your yes."}
                  {short.length > 0 &&
                    ` Shopify has not allowed this yet (${short.join(", ")}): reconnect the store to allow it.`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-fg-muted">{isOn ? "Straight" : "Waits"}</span>
                <Switch
                  checked={isOn}
                  disabled={busy === a || (blocked && !isOn)}
                  onChange={(next) => (next ? setAsking(a) : void set(a, false))}
                  label={`Send "${spec.label}" straight to Shopify`}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {asked && asking && (
        <Dialog
          // Short enough for a phone's sheet; what and where, under it.
          title="Send straight to Shopify?"
          description={`${asked.label} · ${store.shop_domain}`}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" onClick={() => setAsking(null)} className={button("plain")}>
                Keep it waiting
              </button>
              <button
                type="button"
                disabled={busy === asking}
                onClick={() => void set(asking, true)}
                className={button("primary")}
              >
                {busy === asking ? "Turning on…" : "Turn on"}
              </button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-fg">{sendNowSaid(asked, store.shop_domain)}</p>
          <p className="mt-3 text-xs text-fg-muted">
            Kept with your yes: who turned it on, when, and these words. Turning it off is kept too.
          </p>
        </Dialog>
      )}
    </Group>
  );
}
