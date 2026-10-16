-- Migration 0229: ads spending on stock that is running out (16 Oct, the sprint's Days 9–11)
--
-- The sprint's cross-domain case: a campaign keeps spending while what it
-- sells is about to run out. What a campaign sells is taken only from its
-- own orders (the order's last visit named it: utm_campaign is its name
-- or id, as store_campaign_results matches them, 0217), never from what
-- the ad shows: a campaign no order names is said to sell nothing known.
-- Beside each variant its orders bought: the stock on hand, its pace over
-- a sales window, the days it lasts, against the owner's restock time
-- (0222) or a number asked for. Budgets stay the owner's: this only reads.
--
--   abo_ads_stock            Luke's and their own AI's tool (ads_stock),
--                            under the caller's own rights
--   ads_low_stock            the watch on it, off until the owner turns it
--                            on with every number (0199); it rings only when
--                            a quarter or more of what the campaign's orders
--                            bought is running out, two units at least

create or replace function public.abo_ads_stock(p_store uuid, p_days integer default 7, p_sales_days integer default 28, p_cover integer default null)
returns jsonb
language sql stable security invoker set search_path = public set statement_timeout = '10s' as $$
  with s as (
    select greatest(1, least(60, coalesce(p_days, 7))) as days,
           greatest(greatest(1, least(60, coalesce(p_days, 7))), 7, least(180, coalesce(p_sales_days, 28))) as sales_days,
           p.restock_days as lead_days,
           greatest(1, least(180, coalesce(p_cover, p.restock_days, 14))) as cover,
           case when p_cover is not null then 'asked' when p.restock_days is not null then 'restock time' else 'not given: 14 days' end as cover_from,
           (now() at time zone coalesce(st.timezone, 'UTC'))::date - greatest(1, least(60, coalesce(p_days, 7))) + 1 as day0,
           coalesce(st.timezone, 'UTC') as tz
      from public.stores st join public.projects p on p.id = st.project_id
     where st.id = p_store
  ),
  spend as (
    select a.provider, a.campaign_id, max(a.campaign_name) as name, max(a.currency) as currency, sum(a.spend) as spend
      from public.ad_spend a cross join s
     where a.store_id = p_store and a.day >= s.day0
     group by a.provider, a.campaign_id
    having sum(a.spend) > 0
  ),
  -- Each campaign's own orders in the window, by the order's last visit.
  tagged as (
    select sp.provider, sp.campaign_id, o.id as order_id
      from spend sp
     cross join s
      join public.orders o
        on o.store_id = p_store and o.cancelled_at is null
       and nullif(btrim(o.utm_campaign), '') is not null
       and lower(btrim(o.utm_campaign)) in (lower(btrim(sp.name)), lower(sp.campaign_id))
       and (o.placed_at at time zone s.tz)::date >= s.day0
  ),
  bought as (
    select t.provider, t.campaign_id, li.variant_id, sum(li.quantity)::numeric as units
      from tagged t
      join public.order_line_items li on li.order_id = t.order_id and li.store_id = p_store
     where li.variant_id is not null
     group by t.provider, t.campaign_id, li.variant_id
  ),
  pace as (
    select li.variant_id, sum(li.quantity)::numeric / max(s.sales_days) as per_day
      from public.order_line_items li
      join public.orders o on o.id = li.order_id
     cross join s
     where li.store_id = p_store and o.cancelled_at is null
       and li.variant_id in (select variant_id from bought)
       and o.placed_at >= now() - make_interval(days => s.sales_days)
     group by li.variant_id
  ),
  stock as (
    select il.variant_id, greatest(sum(il.available), 0)::numeric as available
      from public.inventory_levels il
     where il.store_id = p_store and il.variant_id in (select variant_id from bought)
     group by il.variant_id
  ),
  v as (
    select b.provider, b.campaign_id, b.units, p.title as product, nullif(va.title, 'Default Title') as variant, va.sku,
           va.tracked is not false as tracked, st.available::int as available, round(pc.per_day, 2) as per_day,
           floor(st.available / nullif(pc.per_day, 0))::int as days_left,
           coalesce(va.tracked is not false
                    and (st.available <= 0 or floor(st.available / nullif(pc.per_day, 0)) <= s.cover), false) as at_risk
      from bought b
      join public.variants va on va.id = b.variant_id
      join public.products p on p.id = va.product_id
      left join stock st on st.variant_id = b.variant_id
      left join pace pc on pc.variant_id = b.variant_id
     cross join s
  ),
  c as (
    select sp.provider, sp.campaign_id, coalesce(sp.name, sp.campaign_id) as campaign, sp.currency, sp.spend,
           (select count(distinct t.order_id) from tagged t
             where t.provider = sp.provider and t.campaign_id = sp.campaign_id) as orders,
           coalesce((select sum(v.units) from v
                      where v.provider = sp.provider and v.campaign_id = sp.campaign_id), 0) as units,
           coalesce((select sum(v.units) from v
                      where v.provider = sp.provider and v.campaign_id = sp.campaign_id and v.at_risk), 0) as units_at_risk
      from spend sp
  )
  select jsonb_build_object(
    'days', s.days,
    'sales_days', s.sales_days,
    'lead_days', s.lead_days,
    'cover_days', s.cover,
    'cover_from', s.cover_from,
    'matched_by', 'what a campaign sells is what its own orders bought: orders whose last visit named the campaign (UTM campaign = its name or id), not what the ad shows',
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider', c.provider, 'campaign_id', c.campaign_id, 'campaign', c.campaign,
               'currency', c.currency, 'spend', round(c.spend, 2), 'orders', c.orders, 'units', c.units::int,
               'units_running_out', c.units_at_risk::int,
               'share_running_out', round(c.units_at_risk / nullif(c.units, 0), 2),
               'spend_on_it', round(c.spend * c.units_at_risk / nullif(c.units, 0), 2),
               'products', (
                 select jsonb_agg(jsonb_build_object(
                          'product', x.product, 'variant', x.variant, 'sku', x.sku, 'units', x.units::int,
                          'share', round(x.units / nullif(c.units, 0), 2),
                          'available', x.available, 'per_day', x.per_day, 'days_left', x.days_left,
                          'runs_out_soon', x.at_risk,
                          'said', case when not x.tracked then 'stock not tracked: it does not run out'
                                       when x.available is null then 'no stock count for it'
                                       when x.available <= 0 then 'out of stock now' end)
                        order by x.at_risk desc, x.units desc)
                   from (select * from v where v.provider = c.provider and v.campaign_id = c.campaign_id
                          order by v.at_risk desc, v.units desc limit 10) x),
               'said', case when c.orders = 0
                            then 'No order in this window names it: what it sells is not known from the store' end)
             order by c.spend * c.units_at_risk / nullif(c.units, 0) desc nulls last, c.spend desc)
        from (select * from c
               order by c.spend * c.units_at_risk / nullif(c.units, 0) desc nulls last, c.spend desc
               limit 50) c
    ), '[]'::jsonb)
  )
  from s
$$;
revoke all on function public.abo_ads_stock(uuid, integer, integer, integer) from public, anon;
grant execute on function public.abo_ads_stock(uuid, integer, integer, integer) to authenticated;

insert into public.alert_kinds (kind, area, needs, check_fn, defaults, sort_order) values
  ('ads_low_stock', 'Ads', '{orders,inventory,ads}', 'abo_alert_ads_low_stock', '{"days": null, "spend": null, "days_left": null}', 7)
on conflict (kind) do update
  set area = excluded.area, needs = excluded.needs, check_fn = excluded.check_fn,
      defaults = excluded.defaults, sort_order = excluded.sort_order;

-- A campaign that spent `spend` or more over the last `days` while a
-- quarter or more of what its orders bought lasts `days_left` days or
-- fewer: critical when one of those is out already. The quarter and the
-- two units are how sure it must be, not the owner's thresholds.
create or replace function public.abo_alert_ads_low_stock(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, least(60, coalesce((p_set->>'days')::int, 7))) as days,
           greatest(1, coalesce((p_set->>'spend')::numeric, 1000)) as spend_min,
           greatest(1, least(90, coalesce((p_set->>'days_left')::int, 7))) as left_days
  ),
  r as (select s.*, public.abo_ads_stock(p_store, s.days, 28, s.left_days) as j from s),
  c as (
    select r.days, r.spend_min, r.j->'lead_days' as lead_days, x.c,
           (select coalesce(jsonb_agg(p.v), '[]'::jsonb)
              from (select v from jsonb_array_elements(x.c->'products') e(v)
                     where (v->>'runs_out_soon')::boolean limit 3) p) as short
      from r cross join jsonb_array_elements(r.j->'campaigns') x(c)
  )
  select c.c->>'provider' || ':' || (c.c->>'campaign_id'),
         case when exists (select 1 from jsonb_array_elements(c.short) e(v) where (v->>'available')::int <= 0)
              then 'critical' else 'attention' end,
         jsonb_build_object('campaign', c.c->>'campaign', 'provider', c.c->>'provider',
                            'spend', c.c->'spend', 'currency', c.c->>'currency', 'orders', c.c->'orders',
                            'share', c.c->'share_running_out', 'days', c.days, 'lead_days', c.lead_days,
                            'products', c.short)
    from c
   where (c.c->>'spend')::numeric >= c.spend_min
     and coalesce((c.c->>'share_running_out')::numeric, 0) >= 0.25
     and coalesce((c.c->>'units_running_out')::int, 0) >= 2
$$;
revoke all on function public.abo_alert_ads_low_stock(uuid, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
