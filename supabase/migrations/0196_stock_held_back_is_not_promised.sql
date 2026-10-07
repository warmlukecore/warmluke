-- Migration 0196: stock held back is not stock promised
--
-- A line with units on the shelf and none to sell read "All promised",
-- whatever held them: an order waiting, or Shopify keeping them back as
-- damaged, safety stock, in quality control or reserved. One unit on hand,
-- none committed and none available read "All promised", and Luke said so
-- beside "committed shows 0" (7 Oct, a phone case Tanish could not sell).
--
-- Now "All promised" is the orders taking all of it (committed at least
-- on hand), and "Held back" is the rest: on the shelf, not for sale, and
-- no order waiting on it. Neither can be sold; only one of them is a
-- customer waiting.
--
-- Written from the view as the database has it (0097), the one case added.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES.inventory_levels), the
-- Overview's stock (abo_overview), and through them Luke's store summary.

create or replace view public.store_inventory with (security_invoker = true) as
 SELECT i.id,
    i.store_id,
    p.title AS product,
    v.title AS variant,
    v.sku,
    NULLIF(i.location_name, ''::text) AS location_name,
    i.available,
    i.on_hand,
    i.committed,
    i.incoming,
        CASE
            WHEN v.tracked IS FALSE THEN 'Not tracked'::text
            WHEN COALESCE(i.on_hand, 0) > 0 AND COALESCE(i.available, 0) <= 0
                 AND COALESCE(i.committed, 0) >= COALESCE(i.on_hand, 0) THEN 'All promised'::text
            WHEN COALESCE(i.on_hand, 0) > 0 AND COALESCE(i.available, 0) <= 0 THEN 'Held back'::text
            WHEN COALESCE(i.available, 0) <= 0 AND COALESCE(i.incoming, 0) > 0 THEN 'Out, more coming'::text
            WHEN COALESCE(i.available, 0) <= 0 THEN 'Out of stock'::text
            ELSE 'In stock'::text
        END AS stock_state,
    v.inventory_item_id,
    i.location_id
   FROM inventory_levels i
     LEFT JOIN variants v ON v.id = i.variant_id
     LEFT JOIN products p ON p.id = v.product_id;

notify pgrst, 'reload schema';
