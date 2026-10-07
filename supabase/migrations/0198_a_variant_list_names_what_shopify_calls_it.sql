-- Migration 0198: a variant's row says what Shopify calls it
--
-- Every column of the store's lists that Shopify lets be changed is edited
-- in place (7 Oct), and a change is aimed by the ids a row carries. The
-- variants list carried none: its price, barcode, SKU and cost could be
-- read but never pointed at. Now each row also has the variant's own id,
-- its product's and its inventory item's, as orders, customers, products
-- and stock rows already do. Not shown: read by the change's aim.
--
-- Written from the view as the database has it (0097), three columns added
-- at its end.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES.variants.gives), and through
-- it the edit cells on a variants list and the changes Luke and their AI ask for.

create or replace view public.store_variants with (security_invoker = true) as
 SELECT v.id,
    v.store_id,
    v.product_id,
    COALESCE(p.title, ''::text) AS product,
    v.title AS variant,
    v.sku,
    v.barcode,
    v.price,
    s.currency,
    v.cost,
        CASE
            WHEN v.cost IS NOT NULL AND v.price IS NOT NULL THEN v.price - v.cost
            ELSE NULL::numeric
        END AS margin,
        CASE
            WHEN v.cost IS NOT NULL AND v.price IS NOT NULL AND v.price > 0::numeric THEN round((v.price - v.cost) / v.price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS margin_pct,
    v.tracked,
    v.external_id AS shopify_id,
    p.external_id AS product_shopify_id,
    v.inventory_item_id
   FROM variants v
     LEFT JOIN products p ON p.id = v.product_id
     JOIN stores s ON s.id = v.store_id;

notify pgrst, 'reload schema';
