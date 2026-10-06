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
  STORE_TABLES,
  type ListShape,
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

/**
 * The lists narrowed, in words for Luke and their AI, each with the columns
 * it is not shown by the names the app gives them: "orders (not shown:
 * Phone, City)". Named, so a column left out is said to be left out rather
 * than taken for one the store does not have; what it holds is in nothing.
 * Empty when none is.
 */
export function narrowedLists(): string[] {
  const shown = scope.getStore()?.shown ?? {};
  return (Object.keys(shown) as StoreTable[])
    .map((t) => [t, hiddenColumns(t)] as const)
    .filter(([, hidden]) => hidden)
    .map(
      ([t, hidden]) =>
        `${t} (not shown: ${STORE_TABLES[t].columns
          .filter((c) => hidden!.has(c.field))
          .map((c) => c.label)
          .join(", ")})`
    );
}

/**
 * An answer without what this account is not shown, by where its parts come
 * from (store-read SHAPES): a list's rows by that list, an order's customer
 * by the customers list, a key called otherwise by the column it is. A list
 * alone is its rows, keys named as its columns. Outside a request, as it is.
 */
export function narrowResult(shape: ListShape | StoreTable | null, value: unknown): unknown {
  if (!shape || !scope.getStore()?.strip) return value;
  return cut(typeof shape === "string" ? { list: shape } : shape, value);
}

function cut(shape: ListShape, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => cut(shape, v));
  if (!value || typeof value !== "object") return value;
  const hidden = shape.list ? hiddenColumns(shape.list) : null;
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => {
      const inner = shape.nested?.[k];
      if (inner) return [[k, cut(inner, v)]];
      return hidden?.has(shape.names?.[k] ?? k) ? [] : [[k, cut(shape, v)]];
    })
  );
}
