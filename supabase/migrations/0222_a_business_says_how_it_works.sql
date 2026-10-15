-- Migration 0222: a business says how it works (onboarding "Your team", lib/team-facts)
--
-- Who packs, who answers customers, who runs the ads, who restocks, and how
-- long a restock takes to arrive: asked once, after the store is connected,
-- skippable, and kept in Settings. The words go into what Luke knows
-- (merchant_notes, 0220) as lines the work stands on; the restock time is
-- also a number here, because Running low reads it:
--
--   projects.restock_days    how many days a restock takes to arrive
--   projects.team_asked_at   the question was answered or skipped: not asked again
--
-- Running low (0163) now says the restock time beside each product, and a
-- product that runs out before a restock could arrive is critical.

alter table public.projects
  add column if not exists restock_days smallint check (restock_days between 1 and 365),
  add column if not exists team_asked_at timestamptz;

-- 0163's Running low, with the restock time.
create or replace function public.abo_alert_low_stock(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, least(90, coalesce((p_set->>'sales_days')::int, 14))) as days,
           greatest(1, least(90, coalesce((p_set->>'days_left')::numeric, 7))) as left_days,
           (select p.restock_days from public.stores st join public.projects p on p.id = st.project_id
             where st.id = p_store) as lead_days
  ),
  sold as (
    select li.variant_id, sum(li.quantity)::numeric / max(s.days) as per_day
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
  )
  select v.id::text,
         case when st.available / sold.per_day <= 2
                or (s.lead_days is not null and st.available / sold.per_day < s.lead_days)
              then 'critical' else 'attention' end,
         jsonb_build_object(
           'product', p.title, 'variant', nullif(v.title, 'Default Title'), 'sku', v.sku,
           'available', st.available::int, 'per_day', round(sold.per_day, 1),
           'days_left', floor(st.available / sold.per_day)::int, 'sales_days', s.days,
           'lead_days', s.lead_days)
    from sold
    join stock st on st.variant_id = sold.variant_id
    join public.variants v on v.id = sold.variant_id
    join public.products p on p.id = v.product_id
   cross join s
   where sold.per_day > 0 and v.tracked is not false and p.status = 'ACTIVE'
     and st.available / sold.per_day <= s.left_days
$$;
revoke all on function public.abo_alert_low_stock(uuid, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
