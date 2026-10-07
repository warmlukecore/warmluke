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
  /**
   * What it does in a few words, for the one sentence that lists every
   * change ("add or remove tags"): two entries saying the same are said
   * once. A change of fields is said by its noun instead.
   */
  brief?: string;
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
    | { each: string; kind: "count"; label: string; current: string }
    /** Fields of one thing, each target its own values (`set`), keyed by the list's columns. */
    | { kind: "fields"; label: string; noun: string; fields: Readonly<Record<string, FieldSpec>> };
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

/**
 * One field a change sets, as a list's column (7 Oct): what it is called,
 * what may be typed for it, and whether it may be emptied. The column's
 * name is the key, so the list that shows it can be typed into.
 */
export interface FieldSpec {
  label: string;
  input: "text" | "email" | "phone" | "money" | "choice";
  /** For a choice: Shopify's own words, as the copy keeps them. */
  choices?: readonly string[];
  /** May be left empty. */
  blank?: boolean;
  /**
   * Changed only by the merchant typing it on a list: never asked for by
   * Luke or their own AI, nor agreed to on their behalf (a price, a status:
   * NEVER_DOES says which promise it keeps).
   */
  byHand?: boolean;
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

/** What a fields change sets on a target, and what the copy said each was. */
export const setOf = (t: ActionTarget): Record<string, string> =>
  t.set && typeof t.set === "object" ? (t.set as Record<string, string>) : {};
export const wasOf = (t: ActionTarget): Record<string, string> =>
  t.was && typeof t.was === "object" ? (t.was as Record<string, string>) : {};

/** The same value, as a field of this kind reads it: 899 is 899.00, "Active" is "ACTIVE". */
export function sameValue(f: FieldSpec | undefined, a: unknown, b: unknown): boolean {
  const x = a === null || a === undefined ? "" : String(a).trim();
  const y = b === null || b === undefined ? "" : String(b).trim();
  if (f?.input === "money" && x !== "" && y !== "") return Number(x) === Number(y);
  return f?.input === "choice" || f?.input === "email" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Why a value cannot go in this field, or null: checked by the server, and on each cell before it is sent. */
export function fieldProblem(f: FieldSpec, noun: string, raw: unknown): string | null {
  const v = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!v) return f.blank ? null : `A ${noun}'s ${f.label.toLowerCase()} can't be left empty.`;
  if (v.length > 255) return `${f.label} is too long: 255 characters at most.`;
  if (f.input === "money" && !/^\d+(\.\d{1,2})?$/.test(v))
    return `${f.label} has to be an amount of 0 or more, like 499 or 499.50: "${v}" is not one.`;
  if (f.input === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return `"${v}" is not an email address.`;
  if (f.input === "phone" && !/^\+?[\d\s()-]{6,20}$/.test(v)) return `"${v}" is not a phone number.`;
  if (f.input === "choice" && !(f.choices ?? []).some((c) => c.toLowerCase() === v.toLowerCase()))
    return `${f.label} is one of: ${(f.choices ?? []).map((c) => c.charAt(0) + c.slice(1).toLowerCase()).join(", ")}.`;
  return null;
}

const andList = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * A change that sets fields of one kind of thing in one call (7 Oct). Each
 * target carries what it sets (`set`, column → value as the list shows
 * it); the server adds what each was from Warmluke's copy (`was`), and any
 * other id the call needs (`also`), never taken from whoever asked. Its
 * fields are columns, so every list showing one can be typed into, and a
 * field added here is editable wherever it is shown. Put back by setting
 * what was, while the copy still says what this change left.
 */
function fieldsChange(o: {
  name: string;
  label: string;
  noun: string;
  scopes: readonly string[];
  needs: readonly string[];
  aims: Readonly<Record<string, readonly string[]>>;
  fields: Readonly<Record<string, FieldSpec>>;
  /** Where the copy keeps it: the list's view, the column holding the target's id, and ids read with it. */
  copy: { view: string; key: string; also?: Readonly<Record<string, string>> };
  mutation: string;
  variables: (target: ActionTarget, set: Record<string, string>, key: string) => Record<string, unknown>;
}): StoreActionSpec {
  const labelOf = (f: string) => o.fields[f]?.label.toLowerCase() ?? f;
  return {
    label: o.label,
    connector: "shopify",
    scopes: o.scopes,
    needs: o.needs,
    aims: o.aims,
    ask: { kind: "fields", label: o.label, noun: o.noun, fields: o.fields },
    confirm: "list",
    say: (targets) => {
      const changed = [...new Set(targets.flatMap((t) => Object.keys(setOf(t))))];
      if (targets.length === 1 && changed.length === 1) {
        const f = changed[0];
        const was = wasOf(targets[0])[f];
        return `Changes one ${o.noun}'s ${labelOf(f)}${was !== undefined ? ` from "${was}"` : ""} to "${setOf(targets[0])[f]}"`;
      }
      return `Changes the ${andList(changed.map(labelOf))} of ${count(targets.length, o.noun)}`;
    },
    check: (targets) => {
      if (targets.length === 0) return `No ${o.noun} was named.`;
      for (const t of targets) {
        const set = Object.entries(setOf(t));
        if (set.length === 0)
          return `Nothing to change was given for a ${o.noun}: { "set": { "${Object.keys(o.fields)[0]}": "…" } }.`;
        for (const [f, v] of set) {
          const spec = o.fields[f];
          if (!spec)
            return `A ${o.noun}'s "${f}" is not something Warmluke changes. It can change: ${Object.keys(o.fields).join(", ")}.`;
          const wrong = fieldProblem(spec, o.noun, v);
          if (wrong) return wrong;
        }
      }
      return null;
    },
    prepare: async (db, storeId, targets) => {
      const extra = Object.values(o.copy.also ?? {});
      const read = [o.copy.key, ...Object.keys(o.fields), ...extra].join(", ");
      const out: ActionTarget[] = [];
      for (const t of targets) {
        const { data } = await db
          .from(o.copy.view)
          .select(read)
          .eq("store_id", storeId)
          .eq(o.copy.key, t.id)
          .limit(1)
          .maybeSingle();
        const row = data as Record<string, unknown> | null;
        if (!row) {
          return {
            error: `One of those is not a ${o.noun} in Warmluke's copy of the store, so what it is now is not known. Nothing was asked for; look it up again with search_store.`,
          };
        }
        const was = Object.fromEntries(
          Object.keys(setOf(t)).map((f) => [f, row[f] === null || row[f] === undefined ? "" : String(row[f])])
        );
        const also: Record<string, unknown> = {};
        for (const [k, col] of Object.entries(o.copy.also ?? {})) {
          if (typeof row[col] !== "string" || !row[col])
            return { error: `Warmluke's copy does not say which ${k} this ${o.noun} is in.` };
          also[k] = row[col];
        }
        out.push({ ...t, ...also, was });
      }
      return { targets: out };
    },
    mutation: o.mutation,
    variables: (target, _params, { key }) => o.variables(target, setOf(target), key),
    errors: userErrors,
    undo: (targets) => ({
      action: o.name,
      targets: targets
        .filter((t) => Object.keys(setOf(t)).every((f) => f in wasOf(t)))
        .map((t) => ({
          ...t,
          set: Object.fromEntries(Object.keys(setOf(t)).map((f) => [f, wasOf(t)[f]])),
          was: setOf(t),
        })),
      params: {},
    }),
  };
}

/** "Aarav Kumar Sharma": first name Aarav, last name Kumar Sharma, as Shopify keeps a name in two. */
const nameParts = (v: string) => {
  const [first = "", ...rest] = v.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(" ") };
};
const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim());

export const STORE_ACTIONS: Record<string, StoreActionSpec> = {
  // ── Tags ──────────────────────────────────────────────────────
  //
  // The whole of day-to-day operations is marking things so somebody
  // else knows. One mutation, any taggable id, and its own opposite
  // for an undo — which is why this is the first one built.
  add_tags: {
    label: "Add a tag",
    brief: "add or remove tags",
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
    brief: "add or remove tags",
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
    brief: "write an order's note",
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
    brief: "set stock counts",
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
    // Back to the count it changed from, from the count it set: each line
    // carries both, so Shopify puts the old one back only while its count
    // is still the one this change left. A sale or a delivery since, and
    // the undo is refused rather than written over it.
    undo: (targets) => ({
      action: "set_stock",
      targets: targets
        .filter((t) => typeof t.from === "number" && typeof t.quantity === "number")
        .map((t) => ({ id: t.id, locationId: t.locationId, quantity: t.from, from: t.quantity })),
      params: {},
    }),
  },

  // ── Fields of one thing (7 Oct) ───────────────────────────────
  //
  // Every column of a store list that Shopify lets be changed in one
  // call, typed into in a list's edit mode. What stays out is what
  // Shopify keeps as a record (an order's money, number, dates and
  // statuses) or works out itself (counts, totals, margins).
  update_customer: fieldsChange({
    name: "update_customer",
    label: "Change a customer's details",
    noun: "customer",
    scopes: ["write_customers"],
    needs: ["Customer"],
    aims: { id: ["Customer"] },
    fields: {
      name: { label: "Name", input: "text" },
      email: { label: "Email", input: "email", blank: true },
      phone: { label: "Phone", input: "phone", blank: true },
    },
    copy: { view: "store_customers", key: "shopify_id" },
    mutation: `mutation UpdateCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) { customer { id } userErrors { field message } }
    }`,
    variables: (t, set) => ({
      input: {
        id: t.id,
        ...("name" in set ? nameParts(set.name) : {}),
        ...("email" in set ? { email: blankToNull(set.email) } : {}),
        ...("phone" in set ? { phone: blankToNull(set.phone)?.replace(/[\s()-]/g, "") ?? null } : {}),
      },
    }),
  }),

  update_product: fieldsChange({
    name: "update_product",
    label: "Change a product's details",
    noun: "product",
    scopes: ["write_products"],
    needs: ["Product"],
    aims: { id: ["Product"] },
    fields: {
      title: { label: "Title", input: "text" },
      product_type: { label: "Type", input: "text", blank: true },
      vendor: { label: "Vendor", input: "text", blank: true },
      status: { label: "Status", input: "choice", choices: ["ACTIVE", "DRAFT", "ARCHIVED"], byHand: true },
      handle: { label: "Handle", input: "text" },
    },
    copy: { view: "store_products", key: "shopify_id" },
    mutation: `mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } }
    }`,
    variables: (t, set) => ({
      product: {
        id: t.id,
        ...("title" in set ? { title: set.title.trim() } : {}),
        ...("product_type" in set ? { productType: set.product_type.trim() } : {}),
        ...("vendor" in set ? { vendor: set.vendor.trim() } : {}),
        ...("status" in set ? { status: set.status.trim().toUpperCase() } : {}),
        ...("handle" in set ? { handle: set.handle.trim() } : {}),
      },
    }),
  }),

  update_variant: fieldsChange({
    name: "update_variant",
    label: "Change a variant's price or barcode",
    noun: "variant",
    scopes: ["write_products"],
    needs: ["ProductVariant"],
    aims: { id: ["ProductVariant"] },
    fields: {
      price: { label: "Price", input: "money", byHand: true },
      barcode: { label: "Barcode", input: "text", blank: true },
    },
    // Shopify changes a variant through its product, whose id the copy keeps.
    copy: { view: "store_variants", key: "shopify_id", also: { productId: "product_shopify_id" } },
    mutation: `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
    }`,
    variables: (t, set) => ({
      productId: t.productId,
      variants: [
        {
          id: t.id,
          ...("price" in set ? { price: Number(set.price).toFixed(2) } : {}),
          ...("barcode" in set ? { barcode: set.barcode.trim() } : {}),
        },
      ],
    }),
  }),

  update_item: fieldsChange({
    name: "update_item",
    label: "Change an item's SKU or cost",
    noun: "item",
    scopes: ["write_inventory"],
    needs: ["InventoryItem"],
    aims: { id: ["InventoryItem"] },
    fields: {
      sku: { label: "SKU", input: "text", blank: true },
      cost: { label: "Cost", input: "money", blank: true },
    },
    copy: { view: "store_variants", key: "inventory_item_id" },
    mutation: `mutation UpdateItem($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } }
    }`,
    variables: (t, set) => ({
      id: t.id,
      input: {
        ...("sku" in set ? { sku: set.sku.trim() } : {}),
        ...("cost" in set ? { cost: set.cost.trim() === "" ? null : Number(set.cost) } : {}),
      },
    }),
  }),
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
  const specs = ACTIONS.map((a) => STORE_ACTIONS[a]).filter((spec) => spec.connector === connector);
  const said = [
    ...new Set(
      specs
        .filter((spec) => spec.ask.kind !== "fields")
        .map((spec) => spec.brief ?? spec.label.charAt(0).toLowerCase() + spec.label.slice(1))
    ),
  ];
  // Every change of fields as one phrase, by what it changes: a new one adds its noun.
  const nouns = [...new Set(specs.flatMap((spec) => (spec.ask.kind === "fields" ? [`${spec.ask.noun}s`] : [])))];
  if (nouns.length) said.push(`change the details of ${andList(nouns)}`);
  return andList(said);
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
export const NEVER_DOES: ReadonlyArray<{ say: string; stem: string; byHand?: readonly string[] }> = [
  { say: "cancel", stem: "cancel" },
  { say: "refund", stem: "refund" },
  { say: "fulfil", stem: "fulfil" },
  // The merchant may, typing it on a list (7 Oct); Luke and their AI never:
  // each field named here is marked byHand wherever a change sets it.
  { say: "publish", stem: "publish", byHand: ["status"] },
  { say: "reprice", stem: "price", byHand: ["price"] },
];

/**
 * What is never done: "cancel, refund or fulfil" by anyone, and for Luke
 * and an assistant also what only the merchant's own hand changes
 * ("cancel, refund, fulfil, publish or reprice"). The same words everywhere.
 */
export function whatNeverChanges(who: "anyone" | "ai" = "anyone"): string {
  const said = NEVER_DOES.filter((n) => who === "ai" || !n.byHand).map((n) => n.say);
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} or ${said[said.length - 1]}` : (said[0] ?? "");
}

/** What Luke and an assistant never do, though the merchant may by hand: "publish or reprice". */
export function whatOnlyTheMerchantDoes(): string {
  return NEVER_DOES.filter((n) => n.byHand?.length)
    .map((n) => n.say)
    .join(" or ");
}

/** What only the merchant changes, by typing it: "a variant's price and a product's status". */
export function whatOnlyByHand(): string {
  return andList(
    ACTIONS.flatMap((a) => {
      const ask = STORE_ACTIONS[a].ask;
      return ask.kind === "fields"
        ? Object.values(ask.fields)
            .filter((f) => f.byHand)
            .map((f) => `a ${ask.noun}'s ${f.label.toLowerCase()}`)
        : [];
    })
  );
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
/** The columns a change writes when typed into: its fields, or the one column it names. */
export const editsOf = (spec: StoreActionSpec): Array<{ column: string; as: "set" | "add" | "remove" }> =>
  spec.ask.kind === "fields"
    ? Object.keys(spec.ask.fields).map((column) => ({ column, as: "set" as const }))
    : spec.edits
      ? [spec.edits]
      : [];

export function editsFor(
  gives: Readonly<Record<string, string>> | undefined,
  columns: readonly string[]
): Record<string, { set?: string; add?: string; remove?: string }> {
  const out: Record<string, { set?: string; add?: string; remove?: string }> = {};
  for (const a of actionsFor(gives))
    for (const e of editsOf(STORE_ACTIONS[a])) if (columns.includes(e.column)) (out[e.column] ??= {})[e.as] = a;
  // A list of words is edited only when both its adding and its taking are there.
  for (const [c, e] of Object.entries(out)) if (!e.set && !(e.add && e.remove)) delete out[c];
  return out;
}
