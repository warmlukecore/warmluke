# Stock by SKU, and designs that draw from a blank

Status: design, 12 Oct 2026. Phase 1 is built (0213, read only); phases 2–4 wait for the owner's
OK. Three of the open questions were decided on 12 Oct (see the end).

## Scope

Shopify counts stock per listing (one inventory item per variant), whatever the SKU says. Two
needs follow, from Carefone first and from any merchant who sells one thing several ways:

1. **One SKU, one count.** On Carefone 268 SKUs are shared by two or three listings (an
   "iPhone 17 Pro Max" case also listed under 18 Pro Max), and **130 of them already
   disagree**: the same case shows 72 on one listing and 168 on another.
2. **A design draws from its blank.** A printed design has a little stock of its own, printed
   ahead, sold first; after that each sale uses up one blank case, shared by every design on
   it. A design never goes back into the blank (a returned printed case is the design's).

It is not a full inventory system (purchase orders, bins, batches). Everything that is not
pooled stays exactly as it is today: Shopify's count, read in by 0207.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Who counts? | **Per store, chosen by the owner**: Shopify (today, default) or **Warmluke counts what it pools**. Unpooled SKUs stay Shopify's in both. | Tanish's own words: use ours and it is ours; don't, and Shopify stays the truth. Pooling everything is not needed. |
| What is pooled? | **A pool per (store, SKU, location)**: every listing carrying that SKU at that location is a member. | A SKU is the thing on the shelf; a location is where it sits. Carefone has one location; others have three. |
| How does a blank work? | A pool may **draw from** another pool. A design's listings show **its own + its blank's** count; a sale takes from **its own first, then the blank**. A return or restock adds to **its own**, never the blank. | Exactly the order Tanish described; one rule covers every design on a blank. |
| What moves a pool? | **Any change to a member's `available` in Shopify**, as a delta from what Warmluke expected there: orders, cancels, refunds with restock, POS, transfers, hand edits. | One kind of event covers every cause; no per-topic order logic to get wrong. |
| How do we write back? | `inventorySetQuantities` with **`changeFromQuantity`** (compare-and-set) and an idempotency key, the existing `set_stock` door, **batched per pool** (all members in one call). | Already built, checked and undoable (0195); a stale write is refused by Shopify, never written over a sale. |
| Our own echo? | Each member keeps **`expected`**: what we last set or saw. A webhook whose `available` equals it is our echo, so its delta is 0 and it is ignored. | No loop, and no need to tag writes. |
| Two sales at once? | Deltas are applied **one at a time per pool** (a row lock). A push refused as stale re-reads that member (0207's refresh) and tries once more. | Both sales count; neither is lost to a race. |
| Native Shopify bundles? | **Not used** for blanks. | A bundle has no stock of its own (printed-ahead can't exist), and turning hundreds of products into bundles changes the merchant's catalog and packing slips. |
| Consent? | Pushes for pools are their own kind under 0195's switch, and **each push waits in the bell** for the owner's yes (decided 12 Oct; no one-time switch). | A count written to Shopify sells or stops selling; the owner says yes first, as for every store change. |

## Shape

```
Shopify (sale, cancel, restock, hand edit)
   │ inventory_levels/update (available)       0207 marks + recounts
   ▼                                              │
abo_shopify_set_inventory ──► stock_pool_members.expected ─ delta ≠ 0 ─► stock_moves (ledger)
                                                                          │ per pool, locked
                                                                          ▼
                                       stock_pools.available (own) · draw_from → blank pool
                                                                          │ sellable = own + blank
                                                                          ▼
                       import worker (0110 ticket) ── inventorySetQuantities, changeFrom, batch
                                                                          ▼
                                       every member listing in Shopify = sellable
```

## Data model

All carry `store_id`, the store-readable member policy, and the three OAuth walls. Written only
by functions or the import worker's ticket.

- **`stock_pools`**: `sku`, `location_id`, `available` (its own count), `draw_from` (a pool, or
  null), `status` (`active`, `paused`, `needs_attention` with `last_error`). Unique on
  (`store_id`, `sku`, `location_id`).
- **`stock_pool_members`**: `pool_id`, `variant_id`, `inventory_item_id`, `expected` (what
  Warmluke last set or saw in Shopify), `pushed_at`. A variant belongs to at most one pool per
  location.
- **`stock_moves`**: the ledger. `pool_id`, `delta`, `cause` (`shopify`, `owner`, `luke`,
  `start`, `correction`), `ref` (an order, a webhook, a user), `at`. Every count can be
  explained, and Undo reads it. Kept 90 days, then folded into a per-pool total, as 0206 does
  for rule runs.
- **`store_stock_pools`** view + a **`STORE_TABLES`** entry: SKU, listings, own, blank,
  sellable, draws from, status, last change. Sections, Luke, the owner's AI and the Overview
  read it like any store list.

`stores.stock_mode` (`shopify` | `pools`) is the switch, set only by the owner.

## The engine

1. **A change arrives.** The stock webhook (0060/0207) already writes `available`. For a pooled
   member it now also computes `delta = available − expected`. Zero: our echo, done. Otherwise
   it adds a `stock_moves` row and marks the pool due.
2. **The pool moves** (one at a time per pool). The delta goes to the pool's own count. For a
   design whose own count would go below zero, the rest comes from its blank. Then each
   member's `expected` is set to the new sellable count.
3. **The worker pushes** on the existing import ticket (0110, 0207's worker). It reads due pools
   in bounded batches (200 pools a run) and sends one `inventorySetQuantities` per pool with
   every member line. A blank that moved queues every design drawing on it. Throttle-aware
   GraphQL as the import is; a 429 waits, never loops.
4. **A stale push** (`CHANGE_FROM_QUANTITY_STALE`) means a sale landed in between: that member
   is recounted (0207), its delta applied, and the pool pushed again, at most twice, then
   `needs_attention`.

## Switching a store over: the dry run

Settings → Store → **Stock by SKU** opens a preview before anything is written:

- every shared SKU with its listings and their counts today, with **disagreements first** (130
  on Carefone);
- the **starting count** for each pool: by default the **lowest** of its listings (never
  oversells), editable per row;
- for designs tagged with a blank, the sellable count each design listing would show;
- the number of Shopify writes it would make.

**Switch on** writes the `start` moves and pushes. **Switch off** stops all pushes and leaves
Shopify as last set. **Put counts back** restores each listing's count from before the switch,
through `set_stock`'s compare-and-set undo, refused per line where a sale has moved it since.

## UI

Built from tokens and the shared blocks (docs/design/design-system.md):
- `Group` and the preview as one `Dialog`, rows as the standard table with its edit mode;
- the status dot line as Connections uses it;
- the switch is the existing in-app control, never a native select.

Walked at 1440 and 390. The pool list is a store section, so it gets filters, stats, the
Actions menu and column ⓘ for free. "Sellable" carries its meaning in `about`, not in brackets.

## Luke and their own AI

- **Read:** `stock_pools` through `search_store`, `store_metrics` and `read_section`. "Which
  blanks are low", "why does this listing show 12" (from the ledger).
- **Ask:** link a design to its blank, set a pool's count, pause a pool. Each is a proposal in
  the bell, as `change_rows` and `propose_store_action` are. Switching a store's mode stays
  the owner's, in Settings.
- `src/lib/parity.ts` gets one entry per door; `check-parity` fails until it does.
- The radar learns one sign: a pool in `needs_attention`, or one pushed more than 20 times an
  hour (a loop).

## Moving what exists

Carefone's 35 Parent SKU tags (own field `parent_sku`) become `draw_from` links in the preview,
shown for the owner's OK, never silently. The "Parent Stock" section and its sync rules can then
be turned off, from the same screen.

## Checks

- **`check-stock-pools` (pure, Shopify stood in for):**
  - deltas from each cause;
  - echo ignored;
  - draw order (own first, blank after, returns to own);
  - two sales at once;
  - a stale push recounted and retried;
  - a 429 waiting;
  - batch size.
- **`check-stock-pools-live` (check DB):**
  - walls, and the ticket's reach;
  - one pool at a time;
  - the ledger explaining every count;
  - switch off and put back.
- **e2e:** the preview and switch at both widths, with Shopify stood in, as `connections.spec`.
- **Scale:** 20k variants and 5k pools tick inside the worker budget (counted, not timed).

## Phases

1. **See it (no writes, smallest useful). Built, 0213, 12 Oct:**
   - `store_stock_pools`, the `stock_pools` store list ("Stock by SKU" in Add from your store):
     one row per SKU and location listed more than once, made from a blank, or a blank with
     designs. Its listings, `start_count` (the lowest of them, decided 12 Oct), `spread`,
     whether they agree, the blank, and `sellable` (own + blank for a design, decided 12 Oct).
   - **A design's blank is read from what the owner already keeps:** any field of theirs on a
     Stock row whose value is another SKU of the store, whatever the field is called (Carefone's
     Parent SKU is one). No new table and nothing to fill in; phase 3 turns these into
     `draw_from` links with the owner's OK.
   - Worked out by `abo_stock_pools(store)`, one store at a time (21 ms for Carefone's 2,058
     stock rows), so a page never reads another store. Sections, Luke's store tools and the
     owner's AI read it as any store list. Checked by `check-stock-pools-live`.
   - On Carefone's data: 268 shared SKUs, 129 that disagree (by up to 193), and one blank with
     17 designs. One more SKU disagrees only through an untracked variant, which is not stock.
2. **Pools for shared SKUs:** the mode switch, the dry run, the engine, pushes under consent, and the ledger.
3. **Blanks:** `draw_from`, the draw order, design listings showing sellable, and moving Carefone's tags.
4. **Asks and alerts:** Luke/MCP proposals, a low-blank alert (off by default, 0199).

## Questions for the owner

Decided 12 Oct:

1. Starting count when listings disagree: **the lowest**, editable.
2. A design's Shopify listing shows **own + blank**.
4. Pool pushes **wait in the bell each time**, with no one-time switch. Phase 2 must make that
   workable at Carefone's volume: one card per pool or per batch, not per sale.

Still open:

3. Is the blank itself sold as a product (its own listing)? If so, it is a pooled member like
   any other.
5. Pilot on Carefone alone first?
