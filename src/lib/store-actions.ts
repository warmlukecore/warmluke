// ─────────────────────────────────────────────────────────────
// What Warmluke may change in somebody's shop, declared once each.
//
// The read side has done this for thirteen resources since
// shopify-resources.ts: one entry per thing, and the scopes, the
// queries, the webhook topics and the tables all come off it, so
// adding a resource is an entry rather than a hunt through six
// files. This is the same idea pointed the other way.
//
// An entry says everything about one change: which connector it
// belongs to, what Shopify must allow, how sure the merchant has to
// be, how to say it in a sentence, the mutation, how to build one
// call, how to read the answer, and how to put it back. Nothing
// outside this file knows that "add_tags" exists — the executor, the
// card, the tool and the checks all walk the registry.
//
// connector is here from the first entry, before there is a second
// connector to need it. Meta and WhatsApp will not share a data
// model with Shopify — an order is not a message — but they will
// share this: propose, agree, do it once, write down what happened.
// When they arrive they are entries with a different connector, and
// the executor dispatches on it.
//
// Nothing here can run yet. Every scope below is a write scope, and
// the token this app holds has none of them until the app asks for
// them and each merchant reconnects.
//
// Callers: to come — the executor, src/app/api/mcp/route.ts.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One thing a change is done to, and whatever that one needs.
 *
 * An id alone was the first shape and it was wrong within three
 * entries: tagging fifty orders is one tag over fifty ids, but
 * setting stock is a different number per line. So each target
 * carries its own.
 */
export interface ActionTarget {
  /** Shopify's own id, e.g. "gid://shopify/Order/1234". */
  id: string;
  [k: string]: unknown;
}

export type ActionParams = Record<string, unknown>;

/**
 * How certain the merchant has to be before it runs.
 *
 * `list` — the card shows exactly what will change and they press a
 * button. Right for anything that can be put back.
 * `typed` — they type a word first, the way removing a section
 * works. Kept for the ones that cannot be undone.
 */
export type ConfirmLevel = "list" | "typed";

export interface StoreActionSpec {
  /** What it is called where a person reads it. */
  label: string;
  /** Which connected system this belongs to. */
  connector: "shopify";
  /** What the token must be allowed to do. */
  scopes: readonly string[];
  /**
   * The kinds of Shopify id a target carries, as they appear in a
   * gid: "Order", "InventoryItem", "Location".
   *
   * Not decoration. An assistant can only ask for a change it can
   * aim, and it aims with ids it read somewhere — so an action that
   * needs a kind no reading list hands back is an action nobody can
   * ever call. check-action-registry turns that into a failed
   * check rather than a tool that silently never works.
   *
   * Empty means the targets can be anything taggable, which is what
   * Shopify's own tags mutations accept.
   */
  needs: readonly string[];
  /**
   * How a target is aimed from a row of a store list: each key of the
   * target and the kinds of Shopify id it may take, the first a list
   * gives (lib/store-read STORE_TABLES gives). A list whose rows give
   * every key can be changed from its own screen (actionsFor); no list
   * is named here, so a new list or a new change needs nothing else.
   */
  aims: Readonly<Record<string, readonly string[]>>;
  /**
   * What the merchant types for it on a list's screen: one value every
   * target shares (`param`), or a number per target (`each`), set or
   * moved from `current`, the row's column holding it now.
   */
  ask:
    | { param: string; kind: "tags" | "text"; label: string }
    | { each: string; kind: "count"; label: string; current: string };
  /**
   * The column of a list this change writes when it is typed into, in a
   * list's edit mode (7 Oct): set to what was typed, or the words added to
   * or taken from a list of them (tags). A list without that column has
   * nothing of this change to edit in place.
   */
  edits?: { column: string; as: "set" | "add" | "remove" };
  confirm: ConfirmLevel;
  /** One sentence for the card, built from the real numbers. */
  say: (targets: ActionTarget[], params: ActionParams) => string;
  /**
   * What must be true before anybody is asked to agree.
   * Returns the reason it is not, or null when it is fine.
   */
  check: (targets: ActionTarget[], params: ActionParams) => string | null;
  /**
   * What the server adds to each target before anybody is asked, read
   * from Warmluke's own copy and never from whoever asked: the count a
   * stock line is changed FROM. Returns the targets, or why it cannot.
   */
  prepare?: (
    db: SupabaseClient,
    storeId: string,
    targets: ActionTarget[]
  ) => Promise<{ targets: ActionTarget[] } | { error: string }>;
  /** The mutation, one target per call. */
  mutation: string;
  /**
   * `key` is the same for the same target of the same approved change,
   * however often it is sent: a retry after a dropped answer is the one
   * change, not a second one (Shopify's @idempotent, where a mutation takes it).
   */
  variables: (target: ActionTarget, params: ActionParams, ctx: { key: string }) => Record<string, unknown>;
  /** Shopify puts its refusals in userErrors; this finds them. */
  errors: (data: unknown) => string[];
  /** The action that puts this one back, when there is one. */
  undo:
    | ((
        targets: ActionTarget[],
        params: ActionParams
      ) => {
        action: string;
        targets: ActionTarget[];
        params: ActionParams;
      })
    | null;
  /** Why there is no undo, when there is none. Read by the card. */
  undoNote?: string;
}

/** userErrors, wherever in the answer Shopify put them. */
function userErrors(data: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "userErrors" && Array.isArray(val)) {
        for (const e of val) {
          const m = (e as { message?: string })?.message;
          if (m) out.push(m);
        }
      } else {
        walk(val);
      }
    }
  };
  walk(data);
  return out;
}

/** The codes on Shopify's userErrors, wherever it put them. */
function userErrorCodes(data: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "userErrors" && Array.isArray(val)) {
        for (const e of val)
          if (typeof (e as { code?: unknown })?.code === "string") out.push((e as { code: string }).code);
      } else walk(val);
    }
  };
  walk(data);
  return out;
}

const tagsOf = (params: ActionParams): string[] =>
  (Array.isArray(params.tags) ? params.tags : [params.tags])
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim());

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a tag is stuck on. Shopify's tagsAdd takes any taggable id,
 * so one entry covers orders, customers and products rather than
 * three entries that differ by a noun.
 */
const kindOf = (id: string): string => {
  const m = /gid:\/\/shopify\/([A-Za-z]+)\//.exec(id);
  if (!m) return "thing";
  return m[1].replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
};

const kinds = (targets: ActionTarget[]): string => {
  const seen = [...new Set(targets.map((t) => kindOf(t.id)))];
  return seen.length === 1 ? count(targets.length, seen[0]) : count(targets.length, "thing");
};

export const STORE_ACTIONS: Record<string, StoreActionSpec> = {
  // ── Tags ──────────────────────────────────────────────────────
  //
  // The whole of day-to-day operations is marking things so somebody
  // else knows. One mutation, any taggable id, and its own opposite
  // for an undo — which is why this is the first one built.
  add_tags: {
    label: "Add a tag",
    connector: "shopify",
    scopes: ["write_orders", "write_customers", "write_products"],
    needs: ["Order", "Product", "Customer"],
    aims: { id: ["Order", "Product", "Customer"] },
    ask: { param: "tags", kind: "tags", label: "Tag" },
    edits: { column: "tags", as: "add" },
    confirm: "list",
    say: (targets, params) => `Tags ${kinds(targets)} "${tagsOf(params).join('", "')}"`,
    check: (targets, params) =>
      targets.length === 0 ? "Nothing was named to tag." : tagsOf(params).length === 0 ? "No tag was given." : null,
    mutation: `mutation AddTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
    }`,
    variables: (target, params) => ({ id: target.id, tags: tagsOf(params) }),
    errors: userErrors,
    undo: (targets, params) => ({ action: "remove_tags", targets, params }),
  },

  remove_tags: {
    label: "Remove a tag",
    connector: "shopify",
    scopes: ["write_orders", "write_customers", "write_products"],
    needs: ["Order", "Product", "Customer"],
    aims: { id: ["Order", "Product", "Customer"] },
    ask: { param: "tags", kind: "tags", label: "Tag" },
    edits: { column: "tags", as: "remove" },
    confirm: "list",
    say: (targets, params) => `Takes "${tagsOf(params).join('", "')}" off ${kinds(targets)}`,
    check: (targets, params) =>
      targets.length === 0 ? "Nothing was named." : tagsOf(params).length === 0 ? "No tag was given." : null,
    mutation: `mutation RemoveTags($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
    }`,
    variables: (target, params) => ({ id: target.id, tags: tagsOf(params) }),
    errors: userErrors,
    undo: (targets, params) => ({ action: "add_tags", targets, params }),
  },

  // ── A note on an order ────────────────────────────────────────
  set_order_note: {
    label: "Write a note on an order",
    connector: "shopify",
    scopes: ["write_orders"],
    needs: ["Order"],
    aims: { id: ["Order"] },
    ask: { param: "note", kind: "text", label: "Note" },
    edits: { column: "note", as: "set" },
    confirm: "list",
    say: (targets, params) =>
      `Writes a note on ${count(targets.length, "order")}: "${String(params.note ?? "").slice(0, 60)}"`,
    check: (targets, params) =>
      targets.length === 0
        ? "No order was named."
        : typeof params.note !== "string" || params.note.trim() === ""
          ? "There is no note to write."
          : targets.some((t) => !/gid:\/\/shopify\/Order\//.test(t.id))
            ? "A note goes on an order; something else was named."
            : null,
    mutation: `mutation SetOrderNote($input: OrderInput!) {
      orderUpdate(input: $input) { order { id } userErrors { field message } }
    }`,
    variables: (target, params) => ({ input: { id: target.id, note: String(params.note ?? "") } }),
    errors: userErrors,
    // Putting a note back means knowing what it said, and Warmluke
    // does not keep order notes. Offering an undo that silently
    // wrote an empty note would be worse than offering none.
    undo: null,
    undoNote: "Warmluke does not keep what the note said before, so it cannot put the old one back.",
  },

  // ── Stock ─────────────────────────────────────────────────────
  //
  // A number per line, not one number for all of them, which is why
  // each target carries its own quantity.
  set_stock: {
    label: "Set a stock count",
    connector: "shopify",
    scopes: ["write_inventory"],
    needs: ["InventoryItem", "Location"],
    aims: { id: ["InventoryItem"], locationId: ["Location"] },
    // The count on the row now, to move it by a number as well as set it.
    ask: { each: "quantity", kind: "count", label: "Count", current: "available" },
    edits: { column: "available", as: "set" },
    confirm: "list",
    say: (targets) =>
      targets.length === 1
        ? `Sets the count of one item${typeof targets[0].from === "number" ? ` from ${targets[0].from}` : ""} to ${String(targets[0].quantity)}`
        : `Sets the count of ${count(targets.length, "item")}`,
    // The count each line is changed FROM, as Warmluke's copy has it now:
    // Shopify refuses the change if its own count has moved since, so a
    // number that went stale is never written over one that did not.
    // Always the server's: whatever the caller sent as "from" is replaced.
    prepare: async (db, storeId, targets) => {
      const out: ActionTarget[] = [];
      for (const t of targets) {
        const { data } = await db
          .from("store_inventory")
          .select("available")
          .eq("store_id", storeId)
          .eq("inventory_item_id", t.id)
          .eq("location_id", String(t.locationId ?? ""))
          .maybeSingle();
        if (typeof data?.available !== "number") {
          return {
            error:
              "One of those items is not in Warmluke's copy of the stock at that location, so the count it would change from is not known. Nothing was asked for; look it up again with search_store.",
          };
        }
        out.push({ ...t, from: data.available });
      }
      return { targets: out };
    },
    check: (targets) =>
      targets.length === 0
        ? "No item was named."
        : targets.some((t) => !Number.isInteger(t.quantity) || (t.quantity as number) < 0)
          ? "Every item needs a whole count of nought or more."
          : targets.some((t) => typeof t.locationId !== "string" || !t.locationId)
            ? "Every item needs the location it is counted at."
            : null,
    // 2026-07, as Shopify documents it: the idempotency key is required
    // (since 2026-04), every line says the count it changes from
    // (changeFromQuantity, compare-and-swap), and ignoreCompareQuantity
    // is gone. The old shape was refused outright on this version.
    mutation: `mutation SetStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { createdAt }
        userErrors { field message code }
      }
    }`,
    variables: (target, _params, { key }) => ({
      input: {
        name: "available",
        reason: "correction",
        quantities: [
          {
            inventoryItemId: target.id,
            locationId: target.locationId,
            quantity: target.quantity,
            // Null only for a change made before the count was kept with it.
            changeFromQuantity: typeof target.from === "number" ? target.from : null,
          },
        ],
      },
      idempotencyKey: key,
    }),
    errors: (data) =>
      userErrorCodes(data).includes("CHANGE_FROM_QUANTITY_STALE")
        ? [
            "The count in Shopify changed after this was asked for, so nothing was changed. Ask again to set it from the count it has now.",
          ]
        : userErrors(data),
    // The count it had is in Warmluke, but it is a copy that may be
    // minutes old, and writing a stale number back is how a correction
    // becomes a second mistake.
    undo: null,
    undoNote: "The count before this is only a copy here, and may have moved since.",
  },
};

export const ACTIONS: readonly string[] = Object.keys(STORE_ACTIONS);

/** Every write scope the actions need, once each. */
export const ACTION_SCOPES: readonly string[] = [...new Set(ACTIONS.flatMap((a) => STORE_ACTIONS[a].scopes))];

/**
 * What Warmluke can change in a merchant's shop, as one phrase:
 * "add a tag, remove a tag, write a note on an order and set a stock
 * count".
 *
 * Every sentence that promises what Warmluke will and will not do to
 * a store is built from this — the connect box, the landing page, the
 * terms, what a connected assistant is told. They used to be written
 * by hand, and when writing was switched on four of them went on
 * saying "we never write to it" to the people deciding whether to
 * connect. A promise copied into four places is a promise that is
 * wrong in three of them the next time anything changes.
 */
export function whatCanChange(connector: StoreActionSpec["connector"] = "shopify"): string {
  const said = ACTIONS.map((a) => STORE_ACTIONS[a])
    .filter((spec) => spec.connector === connector)
    .map((spec) => spec.label.charAt(0).toLowerCase() + spec.label.slice(1));
  if (said.length === 0) return "";
  if (said.length === 1) return said[0];
  return `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

/**
 * What Warmluke will not do to a shop, said once.
 *
 * Not something the registry can say, because the registry lists
 * what exists and this is what is refused on purpose. So it is a
 * promise, declared here, and it is held to the registry the other
 * way round: check-action-registry fails the moment any action's
 * name, label or mutation touches one of these stems. Add a refund and this
 * promise has to be changed in the same commit, on every page that
 * makes it.
 *
 * `stem` is what gives an action away ("price" catches set_price),
 * `say` is how the sentence puts it.
 */
export const NEVER_DOES = [
  { say: "cancel", stem: "cancel" },
  { say: "refund", stem: "refund" },
  { say: "fulfil", stem: "fulfil" },
  { say: "publish", stem: "publish" },
  { say: "reprice", stem: "price" },
] as const;

/** "cancel, refund, fulfil, publish or reprice" — the same words everywhere. */
export function whatNeverChanges(): string {
  const said = NEVER_DOES.map((n) => n.say);
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} or ${said[said.length - 1]}` : (said[0] ?? "");
}

/** The spec, or null for a name nobody declared. */
export function actionSpec(name: string): StoreActionSpec | null {
  return Object.prototype.hasOwnProperty.call(STORE_ACTIONS, name) ? STORE_ACTIONS[name] : null;
}

/**
 * How many things one change may touch before it has to be split.
 *
 * Not a Shopify limit — a person one. A card saying "tags 4,000
 * orders" is not something anybody can check before agreeing to it,
 * and one mutation per target means it is also the point where a
 * mistake becomes expensive to undo.
 */
export const MOST_TARGETS = 200;

/**
 * The changes a store list's rows can be aimed at, off the registry and
 * the ids the list gives (STORE_TABLES gives): Orders' tags and note,
 * Stock's count. Nothing per list: a list or a change added later is
 * offered on its screen without a line here.
 */
export function actionsFor(gives: Readonly<Record<string, string>> | undefined): string[] {
  if (!gives) return [];
  return ACTIONS.filter((a) => Object.values(STORE_ACTIONS[a].aims).every((kinds) => kinds.some((k) => k in gives)));
}

/** One row as a target of a change, each key from the column its list gives; null when the row lacks one. */
export function targetFrom(
  spec: StoreActionSpec,
  gives: Readonly<Record<string, string>>,
  data: Record<string, unknown>
): ActionTarget | null {
  const target: ActionTarget = { id: "" };
  for (const [key, kinds] of Object.entries(spec.aims)) {
    const kind = kinds.find((k) => k in gives);
    const value = kind ? data[gives[kind]] : undefined;
    if (typeof value !== "string" || !value) return null;
    target[key] = value;
  }
  return target.id ? target : null;
}

/**
 * What the owner agrees to when they let one kind of change go straight
 * to their store (0195): written from the change itself, and kept word
 * for word with their yes, so what they agreed to can be read back.
 */
export function sendNowSaid(spec: StoreActionSpec, shop: string): string {
  const what = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
  const back = spec.undo ? "It can be put back with the opposite change." : (spec.undoNote ?? "It cannot be undone.");
  return `When you ${what} on a list in Warmluke, it is sent to ${shop} at once, without asking you again. It changes your live Shopify store. ${back} What Luke or your own AI asks for, and what your teammates change, still waits for your yes. You can turn this off at any time.`;
}

/**
 * What a list can be edited in place (7 Oct): each of its columns some
 * change writes, with the change that sets it, or the two that add to and
 * take from it. Off the registry and the list's own ids and columns.
 */
export function editsFor(
  gives: Readonly<Record<string, string>> | undefined,
  columns: readonly string[]
): Record<string, { set?: string; add?: string; remove?: string }> {
  const out: Record<string, { set?: string; add?: string; remove?: string }> = {};
  for (const a of actionsFor(gives)) {
    const e = STORE_ACTIONS[a].edits;
    if (!e || !columns.includes(e.column)) continue;
    (out[e.column] ??= {})[e.as] = a;
  }
  // A list of words is edited only when both its adding and its taking are there.
  for (const [c, e] of Object.entries(out)) if (!e.set && !(e.add && e.remove)) delete out[c];
  return out;
}
