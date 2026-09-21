-- Refunds and variants are lists too
--
-- The import brings seven tables; six had a list. Refunds and variants
-- did not, and a list that does not exist cannot be built over — the
-- same gap that had a merchant's assistant hand-typing order lines.
-- These are the last two of what the import already holds. What the
-- import does not bring (fulfilments, discounts, collections) is a
-- different decision, taken when a merchant asks.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES is the same list, in
-- code; check-stats proves the two agree, name by name, view by view).

create or replace view public.store_refunds with (security_invoker = true) as
select
  r.id,
  r.store_id,
  r.order_id,
  o.order_number,
  to_char(coalesce(r.refunded_at, r.created_at), 'YYYY-MM-DD') as refunded_at,
  c.name as customer_name,
  r.amount,
  r.quantity,
  o.currency
from public.refunds r
join public.orders o on o.id = r.order_id
left join public.customers c on c.id = o.customer_id;

grant select on public.store_refunds to authenticated;

create or replace view public.store_variants with (security_invoker = true) as
select
  v.id,
  v.store_id,
  v.product_id,
  coalesce(p.title, '') as product,
  v.title as variant,
  v.sku,
  v.barcode,
  v.price,
  s.currency
from public.variants v
left join public.products p on p.id = v.product_id
join public.stores s on s.id = v.store_id;

grant select on public.store_variants to authenticated;

-- The one mapping, two lines longer (0089).
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'           then 'store_orders'
    when 'customers'        then 'store_customers'
    when 'products'         then 'store_products'
    when 'inventory_levels' then 'store_inventory'
    when 'product_sales'    then 'product_sales'
    when 'order_line_items' then 'store_order_items'
    when 'refunds'          then 'store_refunds'
    when 'variants'         then 'store_variants'
  end;
$$;

NOTIFY pgrst, 'reload schema';
