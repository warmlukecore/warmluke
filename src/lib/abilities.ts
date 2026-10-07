// ─────────────────────────────────────────────────────────────
// What each thing can do, where it runs, and what it promises.
//
// capabilities.ts says what may be BUILT: the column types, views,
// triggers and actions a design is checked against. This says what is
// TRUE when it runs, and was nowhere Luke could read it. Asked for stock
// holds, Luke told a merchant it could not write stock back to Shopify
// (it can: from the chat, with their yes), that stock rows had no item or
// location id (they have both; it was shown the columns, not the keys),
// and that Shopify changes show only after a sync (they arrive in
// seconds). Each was the prompt's gap, not the model's.
//
// So it is built from the registries that run the thing — which store
// lists Shopify keeps up to date (shopify-resources' webhooks), what rows
// are matched on (store-read's keys), what may be changed in the shop and
// what that needs (store-actions) — and it says the limits as plainly as
// the abilities: a rule runs after a save and cannot refuse one, a row
// does not know who changed it, a screen is sealed off. A line here the
// code cannot keep is a promise Luke makes to a merchant: check-abilities
// holds the two together.
//
// Callers: src/lib/ai.ts (the design and talk prompts), the MCP route's
// design_format (an outside AI reads the same words).
// ─────────────────────────────────────────────────────────────

import { STORE_TABLES, storeKeys, type StoreTable } from "@/lib/store-read";
import { SHOPIFY_RESOURCES, type Resource } from "@/lib/shopify-resources";
import { ACTIONS, STORE_ACTIONS, whatCanChange } from "@/lib/store-actions";

const TABLES = Object.keys(STORE_TABLES) as StoreTable[];

/** The Shopify resource a store list is imported with. */
function resourceOf(table: StoreTable): Resource | null {
  const found = (Object.keys(SHOPIFY_RESOURCES) as Resource[]).find((r) =>
    (SHOPIFY_RESOURCES[r].tables as readonly string[]).includes(table)
  );
  return found ?? STORE_TABLES[table].section?.importedWith ?? null;
}

/** Whether Shopify tells Warmluke the moment a list changes, or only on the next import. */
export function isLive(table: StoreTable): boolean {
  const r = resourceOf(table);
  return !!r && SHOPIFY_RESOURCES[r].webhooks.length > 0;
}

/** Shopify's own ids beside Warmluke's, per list, where a list has any. */
export function keysByList(): Array<{ table: StoreTable; label: string; keys: string[] }> {
  return TABLES.map((t) => ({ table: t, label: STORE_TABLES[t].label, keys: storeKeys(t) })).filter((k) =>
    k.keys.some((f) => f !== "id")
  );
}

/** The permissions a shop must have granted for each change it can be asked for. */
function changeScopes(): string {
  return [...new Set(ACTIONS.flatMap((a) => STORE_ACTIONS[a].scopes))].join(", ");
}

/**
 * Where each thing works and what it promises, for a model. The design
 * road and the talk road both read it; so does an outside AI.
 */
export function abilitiesPrompt(): string {
  const live = TABLES.filter(isLive);
  const later = TABLES.filter((t) => !isLive(t));
  const keys = keysByList()
    .map((k) => `${k.table}: ${k.keys.join(", ")}`)
    .join("; ");
  return `WHERE EACH THING WORKS, AND WHAT IT PROMISES — true of this platform as it runs today. Promise no more than this, and when a request needs more, say which line it needs.
- READING THE STORE. The store's lists update within seconds of a change in Shopify (${live.join(", ")})${later.length ? `; ${later.join(", ")} only when the store is read again` : ""}. What a row holds is every field its list has, not only the columns a section shows: a field missing from a section's columns is not a field missing from the data. A value that is null is known to be empty; a field no tool returned is unknown, and one empty lookup is not proof that something does not exist.
- MATCHING A STORE ROW. By its keys — ${keys} — never by a name, a title or a SKU: two customers can share a name, and a SKU can be blank or repeated. Where only a name is given, find the candidates and ask which one, or match on something that tells them apart (email, phone, order number).
- STOCK FIGURES. "available" is Shopify's own figure: what is on hand less what orders have already committed. Never take committed off it again; "on_hand" is what is physically there.
- CHANGING THE SHOP ITSELF (${whatCanChange()}). Asked for in this chat (a card each) or made by the owner on a list's ticked rows; each waits for their yes unless Settings → Store sends that kind straight, never what you ask; the store must have allowed it (${changeScopes()}). It cannot be started by a rule, a button, a scan or a screen: a section does not write to Shopify on its own. A stock count is set only if Shopify's count is still the one Warmluke saw; if it moved, the change is refused rather than forced.
- RULES. Most run AFTER a row is saved: they set fields, add rows, and flag what clashes (count_matching) — flagging is seeing it, not stopping it. A before_save rule runs BEFORE the save and refuses it with the owner's sentence: the database judges it in the same moment, one save at a time for that rule, so two people at once cannot both get the last unit, the same slot or the same job, whichever way the row is written (the app, a screen, a rule, their own AI). It guards Warmluke's rows only: Shopify, a till or another app can still change the store's own stock, so a hold in Warmluke is a hold in Warmluke. Never offer flagging as if it were stopping, and never quietly swap one for the other.
- WHO DID IT. Every row records the login that added it and the login that last changed it, written by the database from who is signed in — never what anybody types or sends. So "who packed it" is answered by the row itself, and a name field for it is not needed; a typed name is only what somebody typed. A rule does not yet choose by who is saving (only the owner may approve, only the one who claimed may release): where that is asked for, say so.
- HISTORY. Every add, change and removal of a row is kept, with who did it, when, whether it was them or a rule on their save, and what the row held before and after; anyone who can see the section can read it, and nobody can change it. It is shown on the row; a rule does not read it.
- A TEAM. The owner can add people; each sees the sections shared with them, and the store only if the owner allows it. They add and change rows. The owner can also let one build: with Luke and with their own AI, sections of their own, which they alone change and share, paid from the owner's included designs; the owner sees and can hide all of it.
- MANY ROWS AT ONCE. Every table lets the person tick rows (or every row shown) and press one of the section's row buttons on all of them, or set one of their own fields to the same value on all of them: each row goes exactly as one press would, so a button's "when" and "approval" still hold row by row. So "mark these orders RTO", "set these to Packed" or "tick all of today's" is a row button or a field of theirs, ticked rows and one press, never a workaround and never "not possible". Their own AI cannot press it; it can show the rows (show_on_screen) and tell them to tick and press.
- A SCREEN runs sealed off with only wl.*: it reads rows, keeps fields and adds rows. It cannot reach Shopify, the internet, or anything outside its app.`;
}
