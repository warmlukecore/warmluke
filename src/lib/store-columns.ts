// What an account is shown of the store's lists (0192), on the server: read
// once a request, and in force for everything that request does, so Luke's
// brief, his checks, his lookups and their own AI's tools all name the same
// columns the app shows, without a parameter passed through each of them.
// AsyncLocalStorage, as lib/usage.ts keeps a turn's meter. Rows read inside
// are cut to it as well (store-read narrowRow); a rule running on its own is
// outside any request and reads its rows whole, so nothing built breaks.
//
// Callers: src/lib/engine.ts (runTurn), src/app/api/mcp/route.ts (each tool
// call), src/app/api/apply/route.ts, src/lib/store-tools.ts (narrowResult).

import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hiddenColumns,
  isStoreTable,
  readShownFrom,
  type ShownScope,
  type StoreShown,
  type StoreTable,
} from "@/lib/store-read";

const scope = new AsyncLocalStorage<ShownScope>();
readShownFrom(() => scope.getStore());

/** An app's lists as its owner's account is shown them; every column when it cannot be read. */
export async function storeShownFor(db: SupabaseClient, projectId: string | null | undefined): Promise<StoreShown> {
  if (!projectId) return {};
  const { data, error } = await db.rpc("abo_store_columns", { p_project: projectId });
  if (error || !data || typeof data !== "object") return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(
      ([table, fields]) => isStoreTable(table) && Array.isArray(fields) && fields.length > 0
    )
  ) as StoreShown;
}

/** `fn` with the account's choice in force, its rows cut to it. */
export function withStoreShown<T>(shown: StoreShown, fn: () => Promise<T>): Promise<T> {
  return scope.run({ shown, strip: true }, fn);
}

/**
 * The choice in force for the rest of this request: for a handler whose
 * app is known only part way through (an MCP call names its app in its
 * arguments). The request's own async context; no other request sees it.
 */
export function enterStoreShown(shown: StoreShown) {
  scope.enterWith({ shown, strip: true });
}

/** The lists narrowed, in words for Luke and their AI: "orders (8 of its columns not shown)". Empty when none is. */
export function narrowedLists(): string[] {
  const shown = scope.getStore()?.shown ?? {};
  return (Object.keys(shown) as StoreTable[])
    .map((t) => [t, hiddenColumns(t)] as const)
    .filter(([, hidden]) => hidden)
    .map(([t, hidden]) => `${t} (${hidden!.size} of its columns not shown)`);
}

/**
 * A lookup's answer without what this account is not shown of `table`:
 * every key of that list's hidden columns, wherever it sits in the answer
 * (a row, a list of rows, an order with its lines).
 */
export function narrowResult(table: StoreTable | null, value: unknown): unknown {
  const hidden = table && scope.getStore()?.strip ? hiddenColumns(table) : null;
  if (!hidden) return value;
  const cut = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(cut)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !hidden.has(k))
              .map(([k, x]) => [k, cut(x)])
          )
        : v;
  return cut(value);
}
