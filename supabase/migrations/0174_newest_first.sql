-- Migration 0174: newest first
--
-- Every list opens with its newest row on top (Tanish, 3 Oct): "the last
-- order, the last product that was created, at the top, by default". The
-- store's lists of events already did, by when each happened; products
-- and customers opened A to Z. Each now says when it reached the app
-- (its first import, or the moment Shopify sent it since), added last,
-- so a section over it opens newest first.
--
-- ponytail: when it reached the app, not Shopify's own createdAt, which
-- the import does not read for these two yet: within the first import
-- the order is the import's. Read createdAt into the rows when that
-- matters.

create or replace view public.store_products with (security_invoker = true) as
select
  p.id,
  p.store_id,
  p.title,
  p.product_type,
  p.vendor,
  p.handle,
  p.status,
  nullif(array_to_string(p.tags, ', '), '') as tags,
  (select nullif(string_agg(c.title, ', ' order by c.title), '')
     from public.collection_products cp
     join public.collections c on c.id = cp.collection_id
    where cp.product_id = p.id) as collections,
  p.external_id as shopify_id,
  -- As product_sales counts a sale: an order not cancelled.
  (select max(o.placed_at)
     from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where li.product_id = p.id and o.cancelled_at is null) as last_sold,
  -- When it reached the app, for newest first (0174).
  p.created_at
from public.products p;

create or replace view public.store_customers with (security_invoker = true) as
SELECT id,
    store_id,
    name,
    COALESCE(NULLIF(phone, ''::text), order_phone) AS phone,
    email,
    city,
    orders_count,
    total_spent,
    external_id AS shopify_id,
    regexp_replace(COALESCE(NULLIF(phone, ''::text), order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits,
    created_at
   FROM customers;

NOTIFY pgrst, 'reload schema';
