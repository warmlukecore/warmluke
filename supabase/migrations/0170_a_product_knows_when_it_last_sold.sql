-- Migration 0170: a product knows when it last sold
--
-- "Alert me when a product hasn't sold in 10 days" is the dead-stock
-- question every store asks. The store's products did not say when each
-- last sold; the sales list (product_sales) did, but only for products
-- that have sold, so one never sold was not on it. Luke answered by
-- building a sales section and a products section and a rule of code to
-- carry the date across: three things for one alert. Now the product's
-- own row says when it last sold, empty if it never has, and the alert
-- is one rule over the products.
--
-- Read through idx_order_line_items_product, only for the rows asked for.
-- ponytail: a scalar subquery a row; a filter or sort on it over a huge
-- catalogue reads every product's lines. Keep a last_sold column on
-- products, set by the order upsert, if that ever shows in the timings.

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
    where li.product_id = p.id and o.cancelled_at is null) as last_sold
from public.products p;

NOTIFY pgrst, 'reload schema';
