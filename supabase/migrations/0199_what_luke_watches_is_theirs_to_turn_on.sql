-- Migration 0199: what Luke watches is the merchant's to turn on, and to number
--
-- Every alert was on until a merchant turned it off, at numbers they never
-- chose (stock lasting 7 days judged on 14, late after 48 hours, and so on),
-- and each check carried those numbers again inside itself as a fallback.
-- Now nothing is watched until the merchant turns it on and gives every
-- number it takes (8 Oct: "by default off, the customer chooses").
--
-- - alert_settings.enabled defaults to false, and no row is off.
-- - alert_kinds.defaults keeps the names of the settings a kind takes, with
--   no numbers: what it takes, not what it is set to.
-- - A kind runs only when it is on and every one of its settings is given;
--   on with one missing, it waits, and abo_alert_settings says so ('set').
-- - The four checks read their settings as given: no number of their own.
--
-- Production had no project with settings of its own (8 Oct), so every
-- alert there was on by default only: it is off from the next run, and what
-- it had open closes, until the merchant turns it on.
--
-- Callers: src/components/Alerts.tsx (AlertSettings, AlertPicker), the
-- cron and triggers that run abo_alerts_run, scripts/check-alerts.mjs.

alter table public.alert_settings alter column enabled set default false;

update public.alert_kinds ak
   set defaults = (select coalesce(jsonb_object_agg(x.key, null), '{}'::jsonb) from jsonb_object_keys(ak.defaults) x(key))
 where ak.check_fn is not null;
comment on column public.alert_kinds.defaults is
  'The settings this kind takes, by name, with no numbers: each is the merchant''s to give (0199).';

CREATE OR REPLACE FUNCTION public.abo_alert_low_stock(p_store uuid, p_set jsonb)
 RETURNS TABLE(subject text, severity text, facts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select greatest(1, least(90, (p_set->>'sales_days')::int)) as days,
           greatest(1, least(90, (p_set->>'days_left')::numeric)) as left_days
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
         case when st.available / sold.per_day <= 2 then 'critical' else 'attention' end,
         jsonb_build_object(
           'product', p.title, 'variant', nullif(v.title, 'Default Title'), 'sku', v.sku,
           'available', st.available::int, 'per_day', round(sold.per_day, 1),
           'days_left', floor(st.available / sold.per_day)::int, 'sales_days', s.days)
    from sold
    join stock st on st.variant_id = sold.variant_id
    join public.variants v on v.id = sold.variant_id
    join public.products p on p.id = v.product_id
   cross join s
   where sold.per_day > 0 and v.tracked is not false and p.status = 'ACTIVE'
     and st.available / sold.per_day <= s.left_days
$function$;

CREATE OR REPLACE FUNCTION public.abo_alert_dispatch_late(p_store uuid, p_set jsonb)
 RETURNS TABLE(subject text, severity text, facts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select greatest(1, least(720, (p_set->>'hours')::int)) as hours,
           greatest(1, least(365, (p_set->>'since_days')::int)) as since
  ),
  late as (
    select o.order_number, o.placed_at
      from public.orders o
     cross join s
     where o.store_id = p_store and o.cancelled_at is null
       and coalesce(o.fulfilment_status, 'UNFULFILLED') in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'OPEN', 'IN_PROGRESS')
       and coalesce(o.financial_status, '') not in ('REFUNDED', 'VOIDED')
       and o.placed_at < now() - make_interval(hours => s.hours)
       and o.placed_at > now() - make_interval(days => s.since)
       and not exists (select 1 from public.fulfillments f where f.order_id = o.id and f.shipped_at is not null)
  )
  select 'orders',
         case when count(*) >= 10 or min(late.placed_at) < now() - make_interval(hours => max(s.hours) * 2)
              then 'critical' else 'attention' end,
         jsonb_build_object(
           'count', count(*), 'hours', max(s.hours),
           'oldest_hours', floor(extract(epoch from now() - min(late.placed_at)) / 3600)::int,
           'orders', (select jsonb_agg(x.order_number order by x.placed_at)
                        from (select order_number, placed_at from late order by placed_at limit 5) x))
    from late cross join s
  having count(*) > 0
$function$;

CREATE OR REPLACE FUNCTION public.abo_alert_returns_spike(p_store uuid, p_set jsonb)
 RETURNS TABLE(subject text, severity text, facts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select greatest(1, (p_set->>'min')::int) as min_units,
           greatest(1.1, (p_set->>'times')::numeric) as times
  ),
  rl as (
    select coalesce(rli.product_id::text, lower(btrim(rli.title))) as key, max(rli.title) as title,
           coalesce(sum(rli.quantity) filter (where r.requested_at >= now() - interval '7 days'), 0) as this_week,
           coalesce(sum(rli.quantity) filter (where r.requested_at < now() - interval '7 days'), 0) / 4.0 as per_week
      from public.return_line_items rli
      join public.returns r on r.id = rli.return_id
     where rli.store_id = p_store and r.requested_at >= now() - interval '35 days'
       and coalesce(btrim(rli.title), '') <> ''
     group by 1
  )
  select rl.key,
         case when rl.this_week >= s.min_units * 2 and rl.this_week >= s.times * 2 * rl.per_week
              then 'critical' else 'attention' end,
         jsonb_build_object('product', rl.title, 'this_week', rl.this_week::int, 'per_week', round(rl.per_week, 1))
    from rl cross join s
   where rl.this_week >= s.min_units and rl.this_week >= s.times * rl.per_week
$function$;

CREATE OR REPLACE FUNCTION public.abo_alert_return_reason(p_store uuid, p_set jsonb)
 RETURNS TABLE(subject text, severity text, facts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select greatest(2, (p_set->>'min')::int) as min_count,
           greatest(1, least(90, (p_set->>'days')::int)) as days
  ),
  rs as (
    select lower(btrim(rli.reason)) as key, max(rli.reason) as reason, count(*) as times,
           (array_agg(distinct rli.title) filter (where rli.title is not null))[1:3] as products,
           (array_agg(left(rli.reason_note, 200)) filter (where coalesce(btrim(rli.reason_note), '') <> ''))[1:2] as notes
      from public.return_line_items rli
      join public.returns r on r.id = rli.return_id
     cross join s
     where rli.store_id = p_store and r.requested_at >= now() - make_interval(days => s.days)
       and coalesce(btrim(rli.reason), '') <> '' and lower(btrim(rli.reason)) not in ('other', 'unknown')
     group by 1
  )
  select rs.key,
         case when rs.times >= s.min_count * 2 then 'critical' else 'attention' end,
         jsonb_build_object('reason', rs.reason, 'count', rs.times, 'days', s.days,
                            'products', coalesce(to_jsonb(rs.products), '[]'),
                            'notes', coalesce(to_jsonb(rs.notes), '[]'))
    from rs cross join s
   where rs.times >= s.min_count
$function$;

create or replace function public.abo_alerts_run(p_store uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  st      record;
  k       record;
  r       record;
  v_found text[];
  n       integer := 0;
begin
  for st in
    select s.id, s.project_id from public.stores s
     where s.status = 'connected' and (p_store is null or s.id = p_store)
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('abo_alerts:' || st.id::text, 0)) then
      continue;
    end if;
    for k in
      select ak.kind, ak.needs, ak.check_fn,
             coalesce(se.enabled, false) as enabled,
             coalesce(se.settings, '{}'::jsonb) as settings,
             not exists (select 1 from jsonb_object_keys(ak.defaults) x(key)
                          where not coalesce(se.settings, '{}'::jsonb) ? x.key) as set_up
        from public.alert_kinds ak
        left join public.alert_settings se on se.project_id = st.project_id and se.kind = ak.kind
       where ak.check_fn is not null
       order by ak.sort_order
    loop
      -- Off, or on with a number not yet given: nothing is watched for it.
      if not k.enabled or not k.set_up then
        update public.alerts set status = 'resolved', resolved_at = now(), changed_at = now()
         where store_id = st.id and kind = k.kind and status = 'open';
        continue;
      end if;
      if not public.abo_alert_ready(st.id, k.needs) then
        continue;
      end if;
      v_found := '{}';
      begin
        for r in execute format('select subject, severity, facts from public.%I($1, $2)', k.check_fn)
          using st.id, k.settings
        loop
          insert into public.alerts (project_id, store_id, kind, subject, severity, facts)
          values (st.project_id, st.id, k.kind, r.subject, r.severity, r.facts)
          on conflict (store_id, kind, subject) do update
            set severity        = excluded.severity,
                facts           = excluded.facts,
                status          = 'open',
                resolved_at     = null,
                opened_at       = case when alerts.status = 'resolved' then now() else alerts.opened_at end,
                changed_at      = case when alerts.status = 'resolved'
                                         or (alerts.severity = 'attention' and excluded.severity = 'critical')
                                       then now() else alerts.changed_at end,
                conversation_id = case when alerts.status = 'resolved' then null else alerts.conversation_id end
          where (alerts.status, alerts.severity, alerts.facts)
                is distinct from ('open'::text, excluded.severity, excluded.facts);
          v_found := v_found || r.subject;
          n := n + 1;
        end loop;
        update public.alerts set status = 'resolved', resolved_at = now(), changed_at = now()
         where store_id = st.id and kind = k.kind and status = 'open' and not (subject = any (v_found));
      exception when others then
        raise warning 'alert % on store %: %', k.kind, st.id, sqlerrm;
      end;
    end loop;
    delete from public.alert_dirty where store_id = st.id;
  end loop;
  return n;
end $$;
revoke all on function public.abo_alerts_run(uuid) from public, anon, authenticated;

create or replace function public.abo_alert_settings(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid;
begin
  if p_project is null or not public.abo_can_open_store(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  select s.id into v_store from public.stores s where s.project_id = p_project and s.status = 'connected';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'kind', ak.kind, 'area', ak.area, 'needs', to_jsonb(ak.needs),
             'enabled', coalesce(se.enabled, false), 'defaults', ak.defaults,
             'settings', coalesce(se.settings, '{}'::jsonb),
             'set', not exists (select 1 from jsonb_object_keys(ak.defaults) x(key)
                                where not coalesce(se.settings, '{}'::jsonb) ? x.key),
             'ready', v_store is not null and public.abo_alert_ready(v_store, ak.needs),
             'chosen', se.project_id is not null)
           order by ak.sort_order)
      from public.alert_kinds ak
      left join public.alert_settings se on se.project_id = p_project and se.kind = ak.kind
     where ak.check_fn is not null), '[]'::jsonb);
end $$;
revoke all on function public.abo_alert_settings(uuid) from public, anon;
grant execute on function public.abo_alert_settings(uuid) to authenticated;

notify pgrst, 'reload schema';
