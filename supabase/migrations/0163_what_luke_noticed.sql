-- Migration 0163: what Luke noticed
--
-- What the landing's "What Luke noticed" promised, from the store's own
-- rows: a product about to run out, orders not sent, returns rising for
-- a product, the same return reason coming back. Worked out here, every
-- quarter hour and within a minute of the store's rows changing; shown
-- in the bell and the Overview, and asked of Luke when the owner taps.
--
--   alert_kinds      what can be noticed: the imports it needs and the
--                    function that finds it. A kind whose data is not
--                    here yet raises nothing, and starts the day that
--                    import finishes; a new source (sessions, an ads
--                    account, a helpdesk) is a row here and a function.
--   alert_settings   a project's own thresholds and switches, over the defaults
--   alerts           one row per thing noticed (store, kind, subject): it
--                    opens, changes, resolves when the problem goes, and
--                    opens again if it comes back
--   alert_reads      each person's read and put-away
--   alert_dirty      stores whose rows changed, looked at again soon
--
-- No model is called to notice anything: the words are the app's
-- (lib/alerts.ts), from the facts kept here. Asking Luke about one is a
-- turn like any other, linked back to it (abo_alert_link).

-- ── What can be noticed ─────────────────────────────────────
create table if not exists public.alert_kinds (
  kind       text primary key check (kind ~ '^[a-z_]{2,40}$'),
  area       text not null,
  needs      text[] not null,
  check_fn   text not null check (check_fn ~ '^abo_alert_[a-z_]+$'),
  defaults   jsonb not null default '{}'::jsonb check (jsonb_typeof(defaults) = 'object'),
  sort_order integer not null default 0
);
alter table public.alert_kinds enable row level security;
revoke all on table public.alert_kinds from anon, authenticated;

insert into public.alert_kinds (kind, area, needs, check_fn, defaults, sort_order) values
  ('low_stock', 'Inventory', '{orders,inventory}', 'abo_alert_low_stock',
   '{"days_left": 7, "sales_days": 14}', 1),
  ('dispatch_late', 'Operations', '{orders,fulfillments}', 'abo_alert_dispatch_late',
   '{"hours": 48, "since_days": 30}', 2),
  ('returns_spike', 'Returns', '{returns}', 'abo_alert_returns_spike',
   '{"min": 3, "times": 2}', 3),
  ('return_reason', 'Returns', '{returns}', 'abo_alert_return_reason',
   '{"min": 3, "days": 14}', 4)
on conflict (kind) do update
  set area = excluded.area, needs = excluded.needs, check_fn = excluded.check_fn,
      defaults = excluded.defaults, sort_order = excluded.sort_order;

create table if not exists public.alert_settings (
  project_id uuid not null references public.projects (id) on delete cascade,
  kind       text not null references public.alert_kinds (kind) on delete cascade,
  enabled    boolean not null default true,
  settings   jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (project_id, kind)
);
alter table public.alert_settings enable row level security;
revoke all on table public.alert_settings from anon, authenticated;

-- ── What was noticed ────────────────────────────────────────
create table if not exists public.alerts (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  store_id        uuid not null references public.stores (id) on delete cascade,
  kind            text not null references public.alert_kinds (kind) on delete cascade,
  subject         text not null check (length(subject) between 1 and 200),
  severity        text not null check (severity in ('attention', 'critical')),
  facts           jsonb not null default '{}'::jsonb check (length(facts::text) <= 4000),
  status          text not null default 'open' check (status in ('open', 'resolved')),
  opened_at       timestamptz not null default now(),
  -- When it last asked to be looked at: opened, opened again, or worse.
  -- Its numbers moving (a day less of stock) does not light the bell.
  changed_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  -- Luke's thread about it, once somebody asked.
  conversation_id uuid references public.conversations (id) on delete set null,
  unique (store_id, kind, subject)
);
create index if not exists alerts_project_open on public.alerts (project_id, status, changed_at desc);
alter table public.alerts enable row level security;
revoke all on table public.alerts from anon, authenticated;
-- Read where the store is open to them (0140), for the live stream; the
-- app reads through abo_alerts and writes nothing.
grant select on table public.alerts to authenticated;
drop policy if exists alerts_read on public.alerts;
create policy alerts_read on public.alerts for select to authenticated
  using (public.abo_can_open_store(project_id));
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts') then
    execute 'alter publication supabase_realtime add table public.alerts';
  end if;
end $$;

create table if not exists public.alert_reads (
  alert_id     uuid not null references public.alerts (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  read_at      timestamptz not null default now(),
  -- Put away until it next asks to be looked at.
  dismissed_at timestamptz,
  primary key (alert_id, user_id)
);
alter table public.alert_reads enable row level security;
revoke all on table public.alert_reads from anon, authenticated;

create table if not exists public.alert_dirty (
  store_id uuid primary key references public.stores (id) on delete cascade,
  at       timestamptz not null default now()
);
alter table public.alert_dirty enable row level security;
revoke all on table public.alert_dirty from anon, authenticated;

-- The wall every table has: a client signed in through an MCP grant writes nothing.
do $$
declare
  t text;
begin
  foreach t in array array['alert_kinds', 'alert_settings', 'alerts', 'alert_reads', 'alert_dirty'] loop
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated
                    with check (not public.abo_is_oauth_client())', t || '_oauth_no_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated
                    using (not public.abo_is_oauth_client())', t || '_oauth_no_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated
                    using (not public.abo_is_oauth_client())', t || '_oauth_no_delete', t);
  end loop;
end $$;

-- ── The four checks ─────────────────────────────────────────
-- Each takes the store and its settings (the defaults with the
-- project's over them) and returns what it found: a subject, how bad,
-- and the facts the words are made from.

-- A product that runs out within days_left, at the pace it sold over the last sales_days.
create or replace function public.abo_alert_low_stock(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, least(90, coalesce((p_set->>'sales_days')::int, 14))) as days,
           greatest(1, least(90, coalesce((p_set->>'days_left')::numeric, 7))) as left_days
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
$$;

-- Orders not sent hours after they were placed. Within since_days: an
-- order left months ago is history, not today's work. One alert for all
-- of them, naming the oldest.
create or replace function public.abo_alert_dispatch_late(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, least(720, coalesce((p_set->>'hours')::int, 48))) as hours,
           greatest(1, least(365, coalesce((p_set->>'since_days')::int, 30))) as since
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
$$;

-- A product returned at least min times in the last 7 days, and times
-- as often as its weekly pace over the four weeks before.
create or replace function public.abo_alert_returns_spike(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(1, coalesce((p_set->>'min')::int, 3)) as min_units,
           greatest(1.1, coalesce((p_set->>'times')::numeric, 2)) as times
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
$$;

-- The same return reason at least min times within days.
create or replace function public.abo_alert_return_reason(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  with s as (
    select greatest(2, coalesce((p_set->>'min')::int, 3)) as min_count,
           greatest(1, least(90, coalesce((p_set->>'days')::int, 14))) as days
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
$$;

revoke all on function public.abo_alert_low_stock(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.abo_alert_dispatch_late(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.abo_alert_returns_spike(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.abo_alert_return_reason(uuid, jsonb) from public, anon, authenticated;

-- ── Running them ────────────────────────────────────────────
-- A kind's data is here when every import it needs is done. While one
-- is being walked again (a recheck) it is not: half a list proves nothing.
create or replace function public.abo_alert_ready(p_store uuid, p_needs text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_and(exists (
           select 1 from public.import_runs ir
            where ir.store_id = p_store and ir.resource = need and ir.status = 'done')), false)
    from unnest(p_needs) need
$$;
revoke all on function public.abo_alert_ready(uuid, text[]) from public, anon, authenticated;

-- Every connected store, or one. A kind switched off closes what it had
-- open; one whose data is not ready leaves it as it was; one whose
-- check fails leaves it as it was and says so in the log. A store being
-- looked at already is left to that run, and stays dirty.
-- ponytail: the sweep is one transaction over every store; batch it by
-- store when there are enough stores for that to be slow.
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
             coalesce(se.enabled, true) as enabled,
             ak.defaults || coalesce(se.settings, '{}'::jsonb) as settings
        from public.alert_kinds ak
        left join public.alert_settings se on se.project_id = st.project_id and se.kind = ak.kind
       order by ak.sort_order
    loop
      if not k.enabled then
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
          -- Unchanged, it is left alone: the live stream hears only what moved.
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

-- The stores whose rows changed, once they have been still half a
-- minute: an import writes in bursts, and one look after is enough.
create or replace function public.abo_alerts_run_dirty() returns integer
language plpgsql security definer set search_path = public as $$
declare
  d record;
  n integer := 0;
begin
  for d in select store_id from public.alert_dirty where at < now() - interval '30 seconds' loop
    n := n + public.abo_alerts_run(d.store_id);
  end loop;
  return n;
end $$;
revoke all on function public.abo_alerts_run_dirty() from public, anon, authenticated;

-- A store's rows changed: look again soon. Once a statement, not a row.
create or replace function public.abo_alert_mark_dirty() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.alert_dirty (store_id)
  select distinct c.store_id from changed c where c.store_id is not null
  on conflict (store_id) do update set at = now();
  return null;
end $$;
revoke all on function public.abo_alert_mark_dirty() from public, anon, authenticated;

-- An import finishing is a change too: what it needed is here now.
do $$
declare
  t text;
begin
  foreach t in array array['orders', 'inventory_levels', 'return_line_items', 'fulfillments', 'import_runs'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_alert_dirty_ins_' || t, t);
    execute format('create trigger %I after insert on public.%I referencing new table as changed
                    for each statement execute function public.abo_alert_mark_dirty()', 'trg_alert_dirty_ins_' || t, t);
    execute format('drop trigger if exists %I on public.%I', 'trg_alert_dirty_upd_' || t, t);
    execute format('create trigger %I after update on public.%I referencing new table as changed
                    for each statement execute function public.abo_alert_mark_dirty()', 'trg_alert_dirty_upd_' || t, t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-alerts-dirty', '* * * * *', 'select public.abo_alerts_run_dirty()');
    perform cron.schedule('abo-alerts-sweep', '*/15 * * * *', 'select public.abo_alerts_run()');
  end if;
end $$;

-- ── What the app asks ───────────────────────────────────────
-- What is open in a project, the worst and newest first, with whether
-- this person has seen it since it last asked to be looked at. What
-- they put away is left out until then.
create or replace function public.abo_alerts(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_project is null or not public.abo_can_open_store(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'kind', a.kind, 'subject', a.subject, 'severity', a.severity, 'facts', a.facts,
             'opened_at', a.opened_at, 'changed_at', a.changed_at, 'conversation_id', a.conversation_id,
             'read', coalesce(ar.read_at >= a.changed_at, false))
           order by (a.severity = 'critical') desc, a.changed_at desc)
      from public.alerts a
      -- A store taken off Shopify is looked at no more: what it had open is not today's.
      join public.stores s on s.id = a.store_id and s.status = 'connected'
      left join public.alert_reads ar on ar.alert_id = a.id and ar.user_id = auth.uid()
     where a.project_id = p_project and a.status = 'open'
       and not coalesce(ar.dismissed_at >= a.changed_at, false)), '[]'::jsonb);
end $$;
revoke all on function public.abo_alerts(uuid) from public, anon;
grant execute on function public.abo_alerts(uuid) to authenticated;

-- Seen: the bell's count goes. Put away: gone from the list too.
create or replace function public.abo_alerts_seen(p_alerts uuid[], p_dismiss boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    raise exception 'Not from here.' using errcode = '42501';
  end if;
  insert into public.alert_reads (alert_id, user_id, read_at, dismissed_at)
  select a.id, auth.uid(), now(), case when p_dismiss then now() end
    from public.alerts a
   where a.id = any (p_alerts) and public.abo_can_open_store(a.project_id)
  on conflict (alert_id, user_id) do update
    set read_at = now(),
        dismissed_at = case when p_dismiss then now() else alert_reads.dismissed_at end;
end $$;
revoke all on function public.abo_alerts_seen(uuid[], boolean) from public, anon;
grant execute on function public.abo_alerts_seen(uuid[], boolean) to authenticated;

-- Luke's thread about it, kept on the alert once somebody asks, so the
-- next tap opens the answer rather than asking again. Only a thread of
-- the same project, and only while it has none.
create or replace function public.abo_alert_link(p_alert uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
begin
  select a.project_id into v_project from public.alerts a where a.id = p_alert;
  if v_project is null or not public.abo_can_open_store(v_project) or public.abo_is_oauth_client() then
    raise exception 'No such alert.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations c where c.id = p_conversation and c.project_id = v_project) then
    raise exception 'That conversation is not this project''s.' using errcode = '22023';
  end if;
  update public.alerts set conversation_id = p_conversation
   where id = p_alert and conversation_id is null;
  return found;
end $$;
revoke all on function public.abo_alert_link(uuid, uuid) from public, anon;
grant execute on function public.abo_alert_link(uuid, uuid) to authenticated;

-- What can be noticed in a project: each kind, whether it is on, its
-- settings over the defaults, and whether its data is here yet.
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
             'enabled', coalesce(se.enabled, true), 'defaults', ak.defaults,
             'settings', ak.defaults || coalesce(se.settings, '{}'::jsonb),
             'ready', v_store is not null and public.abo_alert_ready(v_store, ak.needs))
           order by ak.sort_order)
      from public.alert_kinds ak
      left join public.alert_settings se on se.project_id = p_project and se.kind = ak.kind), '[]'::jsonb);
end $$;
revoke all on function public.abo_alert_settings(uuid) from public, anon;
grant execute on function public.abo_alert_settings(uuid) to authenticated;

-- A project's own threshold or switch, by someone who builds there.
-- Only the settings the kind has, each a number from 0 to 10000; looked
-- at again at once, so the list answers the change.
create or replace function public.abo_set_alert_setting(p_project uuid, p_kind text, p_enabled boolean, p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_defaults jsonb;
  k          text;
  v          jsonb;
  v_store    uuid;
begin
  if p_project is null or not public.abo_can_build(p_project) or public.abo_is_oauth_client() then
    raise exception 'Only someone who builds here can change what Luke watches.' using errcode = '42501';
  end if;
  select defaults into v_defaults from public.alert_kinds where kind = p_kind;
  if v_defaults is null then
    raise exception 'No such kind of alert.' using errcode = '22023';
  end if;
  if p_enabled is null or p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Say whether it is on, and its settings.' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(p_settings) loop
    if not v_defaults ? k then
      raise exception '"%" is not a setting of this alert.', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 0 and 10000 then
      raise exception '"%" is a number from 0 to 10000.', k using errcode = '22023';
    end if;
  end loop;
  insert into public.alert_settings (project_id, kind, enabled, settings, updated_at, updated_by)
  values (p_project, p_kind, p_enabled, p_settings, now(), auth.uid())
  on conflict (project_id, kind) do update
    set enabled = excluded.enabled, settings = excluded.settings, updated_at = now(), updated_by = auth.uid();
  select s.id into v_store from public.stores s where s.project_id = p_project and s.status = 'connected';
  if v_store is not null then
    perform public.abo_alerts_run(v_store);
  end if;
  return public.abo_alert_settings(p_project);
end $$;
revoke all on function public.abo_set_alert_setting(uuid, text, boolean, jsonb) from public, anon;
grant execute on function public.abo_set_alert_setting(uuid, text, boolean, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
