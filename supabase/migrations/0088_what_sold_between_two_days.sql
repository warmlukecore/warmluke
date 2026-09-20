-- Migration 0088: what sold between two days.
--
-- product_sales is all time. "Is mahine ka best seller" is not, and the
-- question a merchant asks most about products has a span in it. The
-- same sum as the view, with the span as arguments: uncancelled orders
-- placed from p_from up to but not including p_to.
--
-- Callers: src/lib/slice.ts (fetchSlice, for a routed "sales" question
-- with a time span).

create or replace function public.abo_sales_between(
  p_store uuid,
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit integer default 20
) returns table (title text, units integer, revenue numeric, orders integer)
language sql stable as $$
  select coalesce(max(p.title), max(li.title)) as title,
         sum(li.quantity)::integer as units,
         sum(li.quantity * coalesce(li.price, 0))::numeric(12,2) as revenue,
         count(distinct li.order_id)::integer as orders
    from public.order_line_items li
    join public.orders o on o.id = li.order_id
    left join public.products p on p.id = li.product_id
   where li.store_id = p_store
     and o.cancelled_at is null
     and o.placed_at >= p_from
     and o.placed_at <  p_to
   group by li.store_id, li.product_id, coalesce(li.product_id::text, li.title, '')
   order by 2 desc, 3 desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.abo_sales_between(uuid, timestamptz, timestamptz, integer) from public;
grant execute on function public.abo_sales_between(uuid, timestamptz, timestamptz, integer) to authenticated;

NOTIFY pgrst, 'reload schema';
