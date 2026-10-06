-- An order carries its shipment, and what was given back (6 Oct, Tanish).
-- The orders list said nothing of where an order was: its courier, its
-- tracking number and whether it was delivered lived in the shipments
-- list, seen only by opening the order. And a cancelled or refunded
-- order read ₹0, its current total, with nothing to say what it had been
-- or what was refunded.
--
-- Each order now carries its latest shipment (status, courier, tracking
-- number, shipped and delivered days, and how many shipments it went in)
-- and the sum of its refunds. Columns of the list like any other: the
-- table, filters, cards, Luke and their own AI read them by name, and an
-- administrator can hide them per account (0192). Added at the end of the
-- view, the columns before them unchanged.
--
-- Written from the view as it stands (0173 added customer_email), so no
-- column is lost; the new ones follow it.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES.orders), and through it
-- every reader of the orders list.

create or replace view public.store_orders with (security_invoker = true) as
SELECT o.id,
    o.store_id,
    o.order_number,
    to_char((o.placed_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS placed_at,
    c.name AS customer_name,
    COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone) AS customer_phone,
    o.total,
    o.total_original,
    o.currency,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'Cancelled'::text
            ELSE o.financial_status
        END AS status,
    o.fulfilment_status,
    o.financial_status,
    o.cancelled_at,
    NULLIF(array_to_string(o.tags, ', '::text), ''::text) AS tags,
    o.gateway,
    NULLIF(array_to_string(o.discount_codes, ', '::text), ''::text) AS discount_codes,
    o.ship_city,
    o.ship_state,
    o.ship_country,
    o.subtotal,
    o.tax,
    o.shipping,
    o.discount,
    o.external_id AS shopify_id,
    o.placed_at AS placed_ts,
    regexp_replace(COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits,
    NULLIF(lower(btrim(c.email)), ''::text) AS customer_email,
    sh.shipment_status,
    sh.carrier,
    sh.tracking_number,
    to_char((sh.shipped_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS shipped_at,
    to_char((sh.delivered_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS delivered_at,
    sh.shipments,
    rf.refunded
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store,
            s.timezone AS zone
           FROM stores s) zone_st ON zone_st.zone_store = o.store_id
     -- Its latest shipment, and how many it went in (idx_fulfillments_order).
     LEFT JOIN LATERAL ( SELECT COALESCE(f.shipment_status, f.status) AS shipment_status,
            f.carrier,
            f.tracking_number,
            f.shipped_at,
            f.delivered_at,
            count(*) OVER () AS shipments
           FROM fulfillments f
          WHERE f.order_id = o.id
          ORDER BY f.shipped_at DESC NULLS LAST, f.id DESC
         LIMIT 1) sh ON true
     -- What was given back, all its refunds together (idx_refunds_order).
     LEFT JOIN LATERAL ( SELECT sum(r.amount) AS refunded
           FROM refunds r
          WHERE r.order_id = o.id) rf ON true;

notify pgrst, 'reload schema';
