-- Migration 0225: RTO by comparable cohorts (16 Oct, the sprint's Days 9–11)
--
-- "Why did RTO go up?" answered from the full eligible set, never a page:
-- the shipments sent in the last N days beside those sent in the N days
-- before, each rate counted over a stated denominator (the shipments that
-- settled: delivered or returned to origin), with what is still moving
-- and what has gone quiet (no word in three weeks) said apart, and broken
-- down by courier, payment (COD or prepaid), the order's state, NDR
-- reason or provider. A group with fewer settled shipments than the
-- minimum gets no rate, only its counts, so a 1-in-3 does not read as 33%.
--
-- Read under the caller's own rights (courier_shipments' member read,
-- 0204): their own AI and Luke read exactly what the owner may.

create or replace function public.abo_rto_cohorts(
  p_store uuid, p_days integer default 14, p_by text default 'courier', p_min integer default 20
)
returns jsonb
language sql stable security invoker set search_path = public set statement_timeout = '10s' as $$
  with s as (
    select greatest(3, least(90, coalesce(p_days, 14))) as days,
           greatest(5, least(500, coalesce(p_min, 20))) as min_n,
           case when p_by in ('courier', 'payment', 'state', 'ndr_reason', 'provider') then p_by else 'courier' end as by_
  ),
  sh as (
    select cs.rto,
           (cs.rto or cs.delivered_at is not null) as settled,
           (not cs.rto and cs.delivered_at is null
              and coalesce(cs.status_at, cs.updated_at) < now() - interval '21 days') as quiet,
           coalesce(cs.shipped_at, cs.created_at) >= now() - make_interval(days => s.days) as recent,
           case s.by_
             when 'courier' then coalesce(nullif(btrim(cs.courier), ''), 'Unknown courier')
             when 'payment' then case
               when coalesce(cs.payment_mode, o.gateway, '') ~* 'cod|cash' then 'COD'
               when coalesce(cs.payment_mode, o.gateway, '') = '' then 'Unknown payment'
               else 'Prepaid' end
             when 'state' then coalesce(nullif(btrim(o.ship_state), ''), 'Unknown state')
             when 'ndr_reason' then coalesce(nullif(btrim(cs.ndr_reason), ''), 'No NDR')
             else coalesce(nullif(btrim(cs.provider), ''), 'Unknown') end as grp
      from public.courier_shipments cs
      left join public.orders o on o.id = cs.order_id
     cross join s
     where cs.store_id = p_store
       and coalesce(cs.shipped_at, cs.created_at) >= now() - make_interval(days => s.days * 2)
  ),
  cohort as (
    select recent,
           count(*) as shipped,
           count(*) filter (where settled) as settled,
           count(*) filter (where rto) as rto,
           count(*) filter (where not settled and not quiet) as moving,
           count(*) filter (where quiet) as quiet
      from sh group by recent
  ),
  g as (
    select grp,
           count(*) filter (where recent) as shipped,
           count(*) filter (where recent and settled) as settled,
           count(*) filter (where recent and rto) as rto,
           count(*) filter (where recent and not settled and not quiet) as moving,
           count(*) filter (where not recent and settled) as settled_before,
           count(*) filter (where not recent and rto) as rto_before
      from sh group by grp
  ),
  gr as (
    select g.*,
           case when g.settled >= s.min_n then round(100.0 * g.rto / g.settled, 1) end as rate,
           case when g.settled_before >= s.min_n then round(100.0 * g.rto_before / g.settled_before, 1) end as rate_before
      from g cross join s
  ),
  c as (
    select (select to_jsonb(x) - 'recent' from cohort x where x.recent) as now_,
           (select to_jsonb(x) - 'recent' from cohort x where not x.recent) as before_
  )
  select jsonb_build_object(
    'days', s.days,
    'by', s.by_,
    'min_settled', s.min_n,
    'denominator', 'shipments that settled: delivered or returned to origin',
    'now', coalesce(c.now_, '{}'::jsonb) || jsonb_build_object('rate',
      round(100.0 * (c.now_->>'rto')::numeric / nullif((c.now_->>'settled')::numeric, 0), 1)),
    'before', coalesce(c.before_, '{}'::jsonb) || jsonb_build_object('rate',
      round(100.0 * (c.before_->>'rto')::numeric / nullif((c.before_->>'settled')::numeric, 0), 1)),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', gr.grp, 'shipped', gr.shipped, 'settled', gr.settled, 'rto', gr.rto, 'moving', gr.moving,
               'rate', gr.rate, 'rate_before', gr.rate_before,
               'change', case when gr.rate is not null and gr.rate_before is not null then gr.rate - gr.rate_before end,
               'too_few', gr.rate is null)
             order by gr.rto desc, gr.shipped desc)
        from (select * from gr where gr.shipped > 0 order by gr.rto desc, gr.shipped desc limit 12) gr
    ), '[]'::jsonb)
  )
  from s cross join c
$$;
revoke all on function public.abo_rto_cohorts(uuid, integer, text, integer) from public, anon;
grant execute on function public.abo_rto_cohorts(uuid, integer, text, integer) to authenticated;

notify pgrst, 'reload schema';
