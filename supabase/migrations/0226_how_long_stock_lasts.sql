-- Migration 0226: how long stock lasts, variant by variant (16 Oct, the sprint's Days 9–11)
--
-- "What runs out before I can restock?" answered from every order line in
-- a stated sales window and the stock on hand now, one row a variant:
-- what it sold, its pace a day, the days it lasts, and, beside the
-- restock time the owner gave (projects.restock_days, 0222), whether it
-- runs out before a restock could arrive and the day to reorder by.
--
-- No stock history is kept, so a variant that was out of stock for part
-- of the window sold less than it would have: one out of stock now, or
-- one that sold early in the window and nothing in its last week, is
-- marked so its pace is read as a floor, not a fact. Reordering and
-- adjusting stock stay the owner's: this only reads.
--
-- Read under the caller's own rights (the commerce tables' member read).

create or replace function public.abo_stock_cover(p_store uuid, p_days integer default 28, p_limit integer default 50)
returns jsonb
language sql stable security invoker set search_path = public set statement_timeout = '10s' as $$
  with s as (
    select greatest(7, least(180, coalesce(p_days, 28))) as days,
           greatest(1, least(200, coalesce(p_limit, 50))) as lim,
           (select p.restock_days from public.stores st join public.projects p on p.id = st.project_id
             where st.id = p_store) as lead_days
  ),
  sold as (
    select li.variant_id,
           sum(li.quantity)::numeric as sold,
           sum(li.quantity) filter (where o.placed_at < now() - make_interval(days => s.days / 2))::numeric as sold_early,
           sum(li.quantity) filter (where o.placed_at >= now() - interval '7 days')::numeric as sold_last_week,
           max(o.placed_at) as last_sold_at
      from public.order_line_items li
      join public.orders o on o.id = li.order_id
     cross join s
     where li.store_id = p_store and o.cancelled_at is null and li.variant_id is not null
       and o.placed_at >= now() - make_interval(days => s.days)
     group by li.variant_id
  ),
  stock as (
    select il.variant_id, greatest(sum(il.available), 0)::numeric as available
      from public.inventory_levels il
     where il.store_id = p_store and il.variant_id is not null
     group by il.variant_id
  ),
  cover as (
    select p.title as product, nullif(v.title, 'Default Title') as variant, v.sku,
           st.available::int as available, sold.sold::int as sold,
           round(sold.sold / s.days, 2) as per_day,
           floor(st.available / (sold.sold / s.days))::int as days_left,
           sold.last_sold_at,
           st.available <= 0 as out_now,
           (coalesce(sold.sold_early, 0) > 0 and coalesce(sold.sold_last_week, 0) = 0) as quiet_lately
      from sold
      join stock st on st.variant_id = sold.variant_id
      join public.variants v on v.id = sold.variant_id
      join public.products p on p.id = v.product_id
     cross join s
     where sold.sold > 0 and v.tracked is not false and p.status = 'ACTIVE'
  )
  select jsonb_build_object(
    'days', s.days,
    'lead_days', s.lead_days,
    'pace', 'units sold a day over the window, from every order line not cancelled',
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product', c.product, 'variant', c.variant, 'sku', c.sku,
               'available', c.available, 'sold', c.sold, 'per_day', c.per_day, 'days_left', c.days_left,
               'last_sold_at', c.last_sold_at,
               'runs_out_before_restock', case when s.lead_days is not null then c.days_left < s.lead_days end,
               'reorder_by', case when s.lead_days is not null
                                  then greatest(current_date, current_date + (c.days_left - s.lead_days)) end,
               'pace_is_a_floor', c.out_now or c.quiet_lately,
               'why_a_floor', case when c.out_now then 'out of stock now: it may have sold more had it been in stock'
                                   when c.quiet_lately then 'sold earlier in the window and nothing in its last week: it may have been out of stock'
                              end)
             order by c.days_left, c.per_day desc)
        from (select * from cover order by days_left, per_day desc limit (select lim from s)) c
    ), '[]'::jsonb),
    'selling', (select count(*) from cover)
  )
  from s
$$;
revoke all on function public.abo_stock_cover(uuid, integer, integer) from public, anon;
grant execute on function public.abo_stock_cover(uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';
