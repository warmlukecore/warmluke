-- Migration 0173: an order names its customer's email
--
-- "Flag a repeat order by phone or email" could only match by phone: the
-- store's orders, as a rule or a screen reads them, carried the
-- customer's name and phone and not their email, which almost every
-- order has (2,498 of one store's 2,500). Now each order says it, in
-- lower case and trimmed so one person typed two ways is one person,
-- empty when there is none. Added last, so nothing that reads the list
-- by position moves.

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
    NULLIF(lower(btrim(c.email)), ''::text) AS customer_email
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store,
            s.timezone AS zone
           FROM stores s) zone_st ON zone_st.zone_store = o.store_id;

NOTIFY pgrst, 'reload schema';
