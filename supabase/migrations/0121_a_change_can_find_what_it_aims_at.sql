-- A change to the shop can find what it aims at.
--
-- A change asked for in the shop (a tag, a note) is aimed with Shopify's
-- own id, gid://shopify/Order/1234, and the propose gate refuses anything
-- else. The store lists an assistant reads handed out only our own row
-- id for orders, products and customers, so an assistant asked to tag
-- an order could read the order and still had nothing to aim the tag
-- with. Stock already carried its ids (inventory_item_id, location_id).
--
-- Each view gains shopify_id, the external_id Shopify gave the row, as
-- its last column: CREATE OR REPLACE VIEW may only add at the end, and
-- every other column is exactly as 0098, 0100 and 0087 left it. The
-- lists declare it in `gives` (src/lib/store-read.ts), which is what
-- puts it in every read.
--
-- Callers: src/lib/store-read.ts (readStoreRows, through STORE_TABLES).

create or replace view public.store_orders with (security_invoker = true) as
select
  o.id,
  o.store_id,
  o.order_number,
  to_char(o.placed_at, 'YYYY-MM-DD') as placed_at,
  c.name  as customer_name,
  c.phone as customer_phone,
  o.total,
  o.total_original,
  o.currency,
  case when o.cancelled_at is not null then 'Cancelled' else o.financial_status end as status,
  o.fulfilment_status,
  o.financial_status,
  o.cancelled_at,
  nullif(array_to_string(o.tags, ', '), '') as tags,
  o.gateway,
  nullif(array_to_string(o.discount_codes, ', '), '') as discount_codes,
  o.ship_city,
  o.ship_state,
  o.ship_country,
  o.subtotal,
  o.tax,
  o.shipping,
  o.discount,
  o.external_id as shopify_id
from public.orders o
left join public.customers c on c.id = o.customer_id;

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
  p.external_id as shopify_id
from public.products p;

create or replace view public.store_customers with (security_invoker = true) as
select id, store_id, name, phone, email, city, orders_count, total_spent,
  external_id as shopify_id
from public.customers;

NOTIFY pgrst, 'reload schema';
