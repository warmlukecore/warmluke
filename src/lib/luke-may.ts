// ─────────────────────────────────────────────────────────────
// What Luke may do in an app, and the standing yes (0223, 16 Oct).
//
// One list the owner reads in Settings → Luke: each thing Luke can do,
// and whether it is on, asks them first, is off, or needs something
// connected; so nothing he does or refuses is a surprise.
//
// A standing yes: the owner lets Luke change the rows of a section
// without asking each time, and takes it back whenever they like. It is
// theirs alone (the table refuses anyone else, and any AI's token), it
// applies only while the owner is the one talking to Luke, and the
// change is made exactly as their own yes would make it (lib/row-decide).
//
// Callers: src/components/LukeMay.tsx, src/lib/app-actions.ts,
// scripts/check-luke-may.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type MayState = "on" | "asks" | "off" | "needs";
export type MayRow = { what: string; state: MayState; says: string };

export type MayInput = {
  /** A store is connected and open to them. */
  store: boolean;
  /** The sections Luke changes rows in without asking, by name. */
  granted: string[];
  /** Changes to the shop: whether they may be asked for at all, and the kinds that go without a yes (0195). */
  shop: { on: boolean; auto: number };
  /** Watches turned on with their numbers. */
  watching: number;
};

export const MAY_LABEL: Record<MayState, string> = {
  on: "On",
  asks: "Asks you first",
  off: "Off",
  needs: "Needs a connection",
};

/** Each thing Luke can do here, and where it stands. */
export function lukeMay(i: MayInput): MayRow[] {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return [
    i.store
      ? { what: "Read your store and your sections", state: "on", says: "Orders, products, stock and your own rows." }
      : {
          what: "Read your store",
          state: "needs",
          says: "Connect your store and Luke reads it too; your sections he reads now.",
        },
    {
      what: "Build or change sections and rules",
      state: "asks",
      says: "He shows the design and its checks; nothing is built until you say Build it.",
    },
    i.granted.length
      ? {
          what: "Change values in your rows",
          state: "on",
          says: `Without asking in ${i.granted.join(", ")}; in the rest he asks in your bell.`,
        }
      : { what: "Change values in your rows", state: "asks", says: "Each change waits in your bell for one click." },
    !i.store
      ? { what: "Change your Shopify store", state: "needs", says: "Needs your store connected." }
      : !i.shop.on
        ? { what: "Change your Shopify store", state: "off", says: "Turned off for this store." }
        : i.shop.auto > 0
          ? {
              what: "Change your Shopify store",
              state: "on",
              says: `${n(i.shop.auto, "kind")} of change go straight to the store; the rest wait for your yes.`,
            }
          : { what: "Change your Shopify store", state: "asks", says: "Every change waits for your yes." },
    i.watching > 0
      ? { what: "Watch your store for trouble", state: "on", says: `Watching ${n(i.watching, "thing")}.` }
      : { what: "Watch your store for trouble", state: "off", says: "Nothing is watched; choose in Alerts." },
    {
      what: "Your own AI (Claude, ChatGPT)",
      state: "asks",
      says: "It reads and asks like Luke; only you approve, here, and it never gets a standing yes.",
    },
  ];
}

/** The sections Luke may change rows in without asking, by id. */
export async function grantedSections(db: SupabaseClient, projectId: string): Promise<string[]> {
  const { data } = await db.from("luke_grants").select("module_id").eq("project_id", projectId);
  return (data ?? []).map((g) => g.module_id as string);
}

/** Gives or takes back the standing yes for one section; the owner's alone. Null when done, else why not. */
export async function setGrant(
  db: SupabaseClient,
  projectId: string,
  moduleId: string,
  on: boolean
): Promise<string | null> {
  const { error } = on
    ? await db
        .from("luke_grants")
        .upsert(
          { project_id: projectId, module_id: moduleId },
          { onConflict: "project_id,module_id", ignoreDuplicates: true }
        )
    : await db.from("luke_grants").delete().eq("project_id", projectId).eq("module_id", moduleId);
  return error?.message ?? null;
}

/** This section has the owner's standing yes. Under a teammate's rights the table shows none, and the ask waits. */
export async function hasGrant(db: SupabaseClient, projectId: string, moduleId: string): Promise<boolean> {
  const { data } = await db
    .from("luke_grants")
    .select("module_id")
    .eq("project_id", projectId)
    .eq("module_id", moduleId)
    .maybeSingle();
  return !!data;
}
