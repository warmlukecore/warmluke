// ─────────────────────────────────────────────────────────────
// The store's reading tools, declared once.
//
// A merchant's own assistant calls these over MCP, and Luke is to call
// the same ones. Each is a name, what it is for, the JSON Schema of
// what it takes (exactly what an MCP client is sent), and run(), which
// answers from the caller's own database client: what a tool can see is
// what RLS lets that caller see. Nothing here writes.
//
// The store is settled before a tool runs, by whoever calls it: MCP from
// the shop_domain it adds to every schema, Luke from the project it is
// working in. So no tool here asks which store, and none can guess.
//
// JSON Schema rather than a validation library, on purpose: it is the
// shape clients already read, and the AI SDK takes it as it is. The
// tools read their own arguments leniently, as they always did, since a
// number sent as "10" is still ten.
//
// Nothing here imports Next, so the list can move to its own package the
// day a second app needs it.
//
// Callers: src/app/api/mcp/route.ts, scripts/check-store-tools.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonSchema, tool, type JSONSchema7, type Tool } from "ai";
import {
  dayRangeInZone,
  isStoreTable,
  lowStock,
  orderDetail,
  readStoreRows,
  searchOrders,
  storeLeaders,
  storeOverview,
  STORE_TABLES,
  type StoreBrief,
} from "@/lib/store-read";
import { RESOURCES, SHOPIFY_RESOURCES } from "@/lib/shopify-resources";
import { routeQuestion } from "@/lib/route";
import { fetchSlice } from "@/lib/slice";

/** Who is asking, and about which store. */
export type StoreToolContext = { db: SupabaseClient; store: StoreBrief };

type Args = Record<string, unknown>;

export type StoreTool = {
  name: string;
  /** What it is for, as a model reads it. */
  description: string;
  /** What it takes. The caller adds nothing but, for MCP, which store. */
  inputSchema: JSONSchema7 & { type: "object"; properties: Record<string, JSONSchema7> };
  /** The answer, as a plain object, read with the caller's own client. */
  run: (args: Args, ctx: StoreToolContext) => Promise<unknown>;
};

export const STORE_TOOLS: readonly StoreTool[] = [
  {
    name: "ask_store",
    description:
      "Start here for a question about the shop: who buys most, what sold this month, is #1004 paid, stock of something, how many orders this week. Reads the question, picks the right list and time span, and returns those rows with a line saying what they are. When it cannot tell, it says so and names the tool to use instead.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The merchant's question, in their own words — English or Hinglish.",
        },
      },
      required: ["question"],
    },
    run: async (args, { db, store }) => {
      const question = String(args.question ?? "").trim();
      if (!question) return { error: "What do you want to know? Pass question." };
      const route = await routeQuestion(question);
      if (!route) {
        return {
          could_not_route: true,
          note: "That did not read as a question about one of the store's lists, or not clearly enough. Use store_overview, search_orders, get_order or search_store — or ask again naming the list (orders, customers, products, stock, sales) and the span.",
        };
      }
      const slice = await fetchSlice(db, store, route);
      return {
        read_as: { list: route.list, window: route.window, month: route.month, kind: route.kind },
        ...(slice ?? { what: "nothing matched", rows: [], total: 0 }),
        note: "These rows were chosen from how the question read. Quote them; if they do not fit the question, use the specific tool instead of guessing.",
      };
    },
  },
  {
    name: "store_overview",
    description:
      "What is in the merchant's connected Shopify store: the shop domain, its timezone and currency, when it last synced, and how many rows it holds of each list Shopify fills.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, { db, store }) => {
      // Counts, and the two lists a merchant asks for first. Whole-store
      // figures, unlike search_orders — say so when quoting them.
      const [overview, leaders, runs] = await Promise.all([
        storeOverview(db, store.id),
        storeLeaders(db, store.id),
        // Whether the copy is finished. A count read off a store that
        // is still importing is a true count of what has arrived and
        // a wrong answer to "how many do I have" — and there was no
        // way to tell the two apart from here.
        db.from("import_runs").select("resource, status, imported").eq("store_id", store.id),
      ]);
      const progress = (runs.data ?? []) as Array<{ resource: string; status: string; imported: number }>;
      const ranOf = (r: string) => progress.find((p) => p.resource === r);
      const unfinished = progress.filter((r) => r.status !== "done").map((r) => r.resource);

      // Rows held here that Shopify did not hand back on the last
      // full pass. The import route has worked this out since it was
      // written and shown it to the browser; a connected assistant
      // asked "is anything missing?" had no way to know, and said no.
      //
      // Only once every resource has finished. Part way through,
      // "more here than came back" is just the part that has not
      // arrived yet, and reporting it would cry wolf on every store
      // mid-import. Stock is excluded by the resource itself: its
      // pass counts variants while its table holds one row per
      // location, so the two were never comparable.
      const settled = RESOURCES.every((r) => ranOf(r)?.status === "done");
      const held = (overview?.counts ?? {}) as Record<string, number>;
      const drift = Object.fromEntries(
        RESOURCES.filter((r) => SHOPIFY_RESOURCES[r].drift)
          .map((r) => {
            const holding = held[SHOPIFY_RESOURCES[r].tables[0]] ?? 0;
            return [r, { holding, came_back: ranOf(r)?.imported ?? 0 }] as const;
          })
          .filter(([, v]) => v.holding > v.came_back)
      );

      return {
        ...overview,
        ...leaders,
        importing: Object.fromEntries(progress.map((r) => [r.resource, { status: r.status, imported: r.imported }])),
        note: "top_customers is lifetime spend as Shopify reports it; best_sellers counts every uncancelled order, paid or not. Both cover the whole store.",
        ...(unfinished.length
          ? {
              still_importing: `${unfinished.join(", ")} have not finished coming across. Say the counts are what has arrived so far, not the whole store.`,
            }
          : {}),
        ...(settled && Object.keys(drift).length
          ? {
              not_in_shopify_any_more: drift,
              // Never deleted here, and the reason is worth saying:
              // a pass that came back short looks exactly like a
              // deletion, and a wrong delete does not come back.
              drift_note:
                "These are held here and did not come back from Shopify on the last full pass — most likely removed there while a webhook was not delivered. Nothing has been deleted. Tell the merchant the number and offer a recheck from the app rather than guessing which rows.",
            }
          : {}),
      };
    },
  },
  {
    name: "search_orders",
    description:
      "Find orders in the connected store. A day is read in the store's own timezone, not the caller's — asking for yesterday in New York and getting UTC's yesterday would be a wrong answer.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "string", description: "A single calendar day, YYYY-MM-DD." },
        from: { type: "string", description: "ISO 8601 instant, inclusive." },
        to: { type: "string", description: "ISO 8601 instant, exclusive." },
        status: {
          type: "string",
          description: '"cancelled", or a Shopify financial or fulfilment status such as "paid".',
        },
        q: { type: "string", description: "An order number, or a customer's phone, email or name." },
        limit: { type: "number", description: "Up to 100. Defaults to 20." },
      },
    },
    run: async (args, { db, store }) => {
      const day = args.day as string | undefined;
      // Refused rather than guessed at: a malformed day quietly ignored
      // would answer about every order ever placed.
      if (day) {
        try {
          dayRangeInZone(day, store.timezone);
        } catch {
          return { error: `"${day}" is not a date. Use YYYY-MM-DD.` };
        }
      }
      const hits = await searchOrders(db, store, {
        day,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        status: args.status as string | undefined,
        q: args.q as string | undefined,
        limit: args.limit as number | undefined,
      });
      return {
        shop: store.shop_domain,
        timezone: store.timezone,
        currency: store.currency,
        count: hits.length,
        orders: hits,
      };
    },
  },
  {
    name: "get_order",
    description:
      "One order in full, with the items in it. Use this when the merchant asks about a particular order; search_orders lists many and deliberately leaves the contents out.",
    inputSchema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          description: 'The order number, with or without the "#".',
        },
      },
      required: ["order_number"],
    },
    run: async (args, { db, store }) => {
      const ref = String(args.order_number ?? "").trim();
      if (!ref) return { error: "Which order? Pass order_number." };
      const order = await orderDetail(db, store.id, ref);
      if (!order) {
        return {
          error: `No order ${ref} in ${store.shop_domain}.`,
          // Said plainly, because "not found" on a store that is
          // still importing means "not yet", and answering "you
          // have no such order" would be wrong.
          note: "If the store is still importing, it may not have arrived yet.",
        };
      }
      return { ...order, currency: order.currency ?? store.currency };
    },
  },
  {
    name: "search_store",
    // Named from the one declaration of the lists rather than by hand.
    // This sentence is how the client learns a list exists at all, and
    // it had gone on naming five while the enum below offered nine —
    // so shipments and refunds were searchable and never searched.
    description: `Look through any of the store's lists: ${Object.values(STORE_TABLES)
      .map((spec) => spec.section.label)
      .join(", ")}. Read-only, and it only sees what has been synced from Shopify.`,
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          // The lists are declared once, in store-read; this is that list.
          enum: Object.keys(STORE_TABLES),
          description: "Which of the store's lists to look in.",
        },
        q: {
          type: "string",
          description:
            "Words to look for — a product title, a customer's name or email, an order number. Leave it out to list the most recent.",
        },
        limit: { type: "number", description: "Up to 200. Defaults to 25." },
      },
      required: ["table"],
    },
    run: async (args, { db, store }) => {
      const table = String(args.table ?? "");
      if (!isStoreTable(table)) {
        return { error: `"${table}" is not one of the store's lists.`, available: Object.keys(STORE_TABLES) };
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 200);
      const { rows, total } = await readStoreRows(db, store.id, table, limit, args.q as string | undefined);
      return {
        table,
        // Both numbers, always: "12 rows" out of 4,000 read as an
        // answer about the whole store otherwise.
        matched: total,
        showing: rows.length,
        currency: store.currency,
        rows: rows.map((r) => r.data),
      };
    },
  },
  {
    name: "low_stock",
    description:
      "Products running out: every variant at or below a number, lowest first, with the location it is short at. Ask with threshold 0 for what is already out of stock.",
    inputSchema: {
      type: "object",
      properties: {
        threshold: { type: "number", description: "At or below this count. Defaults to 5." },
        limit: { type: "number", description: "Up to 100. Defaults to 50." },
      },
    },
    run: async (args, { db, store }) => {
      const threshold = Number(args.threshold ?? 5);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return { error: "threshold must be a number, 0 or more." };
      }
      const rows = await lowStock(db, store.id, { threshold, limit: Number(args.limit ?? 50) || 50 });
      return {
        threshold,
        count: rows.length,
        note: rows.length === 0 ? `Nothing is at or below ${threshold}.` : "Counts are as of the last sync from Shopify.",
        rows,
      };
    },
  },
];

const BY_NAME = new Map(STORE_TOOLS.map((t) => [t.name, t]));

/** The store tool of this name, if there is one. */
export const storeTool = (name: unknown): StoreTool | undefined =>
  typeof name === "string" ? BY_NAME.get(name) : undefined;

/** The same tools for the AI SDK, bound to one caller and one store. */
export function aiStoreTools(ctx: StoreToolContext): Record<string, Tool> {
  return Object.fromEntries(
    STORE_TOOLS.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Args>(t.inputSchema),
        execute: (input: Args) => t.run(input, ctx),
      }),
    ])
  );
}
