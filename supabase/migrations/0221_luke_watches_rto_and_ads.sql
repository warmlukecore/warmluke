-- Migration 0221: Luke watches RTO and ads spending without sales (lib/alerts)
--
-- Two more of what Luke notices (0163), on the data the connections bring:
--
--   rto_rising     the share of settled shipments that came back over the
--                  last days, against the weeks before, from the courier's
--                  own RTO mark (courier_shipments.rto, 0204): counted only
--                  over shipments delivered or returned, with those still on
--                  their way said apart, the worst couriers named, and only
--                  once there are enough of both to compare
--   ads_no_sales   a campaign that spent at least a sum over the last days
--                  while the store's own orders from it (store_campaign_results,
--                  0217) stayed at none, or under a ROAS
--
-- As every kind since 0199: off until the owner turns it on and gives
-- every number. Running low (0163) is the stock-cover watch already.
-- No model is called to notice: the words are the app's (lib/alerts.ts).

insert into public.alert_kinds (kind, area, needs, check_fn, defaults, sort_order) values
  ('rto_rising', 'Shipping', '{orders}', 'abo_alert_rto_rising', '{"days": null, "min": null, "points": null}', 5),
  ('ads_no_sales', 'Ads', '{orders}', 'abo_alert_ads_no_sales', '{"days": null, "spend": null, "roas": null}', 6)
on conflict (kind) do update
  set area = excluded.area, needs = excluded.needs, check_fn = excluded.check_fn,
      defaults = excluded.defaults, sort_order = excluded.sort_order;

-- RTO over shipments sent in the last `days`, settled ones only, against the
-- four windows before; at least `min` settled now and ten before, and up by
-- `points` percentage points or more.
create or replace function public.abo_alert_rto_rising(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(3, least(60, coalesce((p_set->>'days')::int, 14))) as days,
           greatest(10, coalesce((p_set->>'min')::int, 30)) as min_settled,
           greatest(1, coalesce((p_set->>'points')::numeric, 5)) as points
  ),
  sh as (
    select coalesce(nullif(btrim(cs.courier), ''), 'Unknown courier') as courier, cs.rto,
           (cs.rto or cs.delivered_at is not null) as settled,
           coalesce(cs.shipped_at, cs.created_at) as sent
      from public.courier_shipments cs
     where cs.store_id = p_store
  ),
  w as (
    select sh.*, sh.sent >= now() - make_interval(days => s.days) as recent
      from sh cross join s
     where sh.sent >= now() - make_interval(days => s.days * 5)
  ),
  n as (
    select count(*) filter (where recent and settled) as settled,
           count(*) filter (where recent and rto) as rto,
           count(*) filter (where recent and not settled) as moving,
           count(*) filter (where not recent and settled) as settled_before,
           count(*) filter (where not recent and rto) as rto_before
      from w
  ),
  r as (
    select n.*, round(100.0 * n.rto / nullif(n.settled, 0), 1) as rate,
           round(100.0 * n.rto_before / nullif(n.settled_before, 0), 1) as rate_before
      from n
  ),
  couriers as (
    select coalesce(jsonb_agg(jsonb_build_object('courier', c.courier, 'rto', c.rto, 'settled', c.settled,
                                                 'rate', round(100.0 * c.rto / c.settled, 1))
                              order by c.rto desc, c.settled desc), '[]'::jsonb) as worst
      from (select courier, count(*) filter (where rto) as rto, count(*) filter (where settled) as settled
              from w where recent group by 1 having count(*) filter (where settled) > 0
             order by 2 desc, 3 desc limit 3) c
  )
  select 'rto',
         case when r.rate >= r.rate_before + 2 * s.points then 'critical' else 'attention' end,
         jsonb_build_object('rate', r.rate, 'rate_before', r.rate_before, 'rto', r.rto, 'settled', r.settled,
                            'moving', r.moving, 'days', s.days, 'couriers', couriers.worst)
    from r cross join s cross join couriers
   where r.settled >= s.min_settled and r.settled_before >= 10
     and r.rate >= r.rate_before + s.points
$$;

-- A campaign that spent at least `spend` over the last `days` of the store's
-- own calendar while the store's orders from it were none, or brought back
-- under `roas` times what it cost.
create or replace function public.abo_alert_ads_no_sales(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, least(60, coalesce((p_set->>'days')::int, 7))) as days,
           greatest(1, coalesce((p_set->>'spend')::numeric, 1000)) as spend_min,
           greatest(0, coalesce((p_set->>'roas')::numeric, 1)) as roas_min
  ),
  since as (
    select to_char((now() at time zone coalesce(st.timezone, 'UTC'))::date - s.days + 1, 'YYYY-MM-DD') as day0
      from public.stores st cross join s
     where st.id = p_store
  ),
  c as (
    select v.provider, v.campaign_id, max(v.campaign_name) as name, max(v.currency) as currency,
           sum(v.spend) as spend, sum(v.store_orders) as orders, sum(v.store_revenue) as revenue,
           sum(v.platform_value) as platform_value
      from public.store_campaign_results v cross join since
     where v.store_id = p_store and v.day >= since.day0
     group by 1, 2
  )
  select c.provider || ':' || c.campaign_id,
         case when c.orders = 0 and c.spend >= s.spend_min * 2 then 'critical' else 'attention' end,
         jsonb_build_object('campaign', coalesce(c.name, c.campaign_id), 'provider', c.provider,
                            'spend', round(c.spend, 2), 'currency', c.currency, 'orders', c.orders,
                            'revenue', round(c.revenue, 2),
                            'roas', round(c.revenue / nullif(c.spend, 0), 2),
                            'platform_roas', round(c.platform_value / nullif(c.spend, 0), 2),
                            'days', s.days)
    from c cross join s
   where c.spend >= s.spend_min
     and (c.orders = 0 or c.revenue / nullif(c.spend, 0) < s.roas_min)
$$;

revoke all on function public.abo_alert_rto_rising(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.abo_alert_ads_no_sales(uuid, jsonb) from public, anon, authenticated;

-- What a connection writes is a change too: look again soon.
do $$
declare
  t text;
begin
  foreach t in array array['courier_shipments', 'ad_spend'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_alert_dirty_ins_' || t, t);
    execute format('create trigger %I after insert on public.%I referencing new table as changed
                    for each statement execute function public.abo_alert_mark_dirty()', 'trg_alert_dirty_ins_' || t, t);
    execute format('drop trigger if exists %I on public.%I', 'trg_alert_dirty_upd_' || t, t);
    execute format('create trigger %I after update on public.%I referencing new table as changed
                    for each statement execute function public.abo_alert_mark_dirty()', 'trg_alert_dirty_upd_' || t, t);
  end loop;
end $$;

notify pgrst, 'reload schema';
