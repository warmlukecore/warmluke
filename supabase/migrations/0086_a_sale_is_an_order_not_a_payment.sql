-- Migration 0086: a sale is an order, not a payment.
--
-- 0084 counted product sales from PAID orders only. The first real
-- store it met had four orders, all cash on delivery, all PENDING in
-- Shopify — and no best sellers at all. For a shop that collects at
-- the door, "paid" is a bookkeeping state that lags the sale by days
-- or never changes; what sold is what was ordered and not cancelled.
-- So the view counts every uncancelled order, and its revenue is the
-- value of those orders, not what has been collected — the orders
-- list already says which of that is PAID.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES.product_sales,
-- storeLeaders).

create or replace view public.product_sales
with (security_invoker = true) as
select
  md5(li.store_id::text || ':' || coalesce(li.product_id::text, li.title, ''))::uuid as id,
  li.store_id,
  li.product_id,
  coalesce(max(p.title), max(li.title)) as title,
  sum(li.quantity)::integer as units,
  sum(li.quantity * coalesce(li.price, 0))::numeric(12,2) as revenue,
  count(distinct li.order_id)::integer as orders,
  max(o.placed_at) as last_sold,
  max(o.currency) as currency
from public.order_line_items li
join public.orders o on o.id = li.order_id
left join public.products p on p.id = li.product_id
where o.cancelled_at is null
group by li.store_id, li.product_id, coalesce(li.product_id::text, li.title, '');

grant select on public.product_sales to authenticated;

NOTIFY pgrst, 'reload schema';
