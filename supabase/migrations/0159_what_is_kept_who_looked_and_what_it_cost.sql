-- Migration 0159: what is kept, who looked, and what it cost
--
-- Three screens of the superadmin console, and the searches they lean on.
--
--   how long traces are kept   trace_retention, abo_admin_retention, abo_admin_set_retention,
--                              abo_admin_sweep_traces; abo_trace_sweep daily, once switched on
--   what administrators did    abo_admin_access_log
--   what Luke cost             abo_admin_spend
--   finding things by a word   trigram indexes on conversation titles, project names, shops

-- ── How long traces are kept ────────────────────────────────
-- Off until an administrator switches it on: a trace is how a reported
-- conversation is understood afterwards, and nothing about keeping one
-- is urgent. Only turn_traces are ever swept; messages, records and the
-- audit trail are not. What Luke cost is read from the traces, so Spend
-- reaches back only as far as they do.
create table if not exists public.trace_retention (
  id           boolean primary key default true check (id),
  enabled      boolean not null default false,
  days         integer not null default 90 check (days between 7 and 3650),
  last_run_at  timestamptz,
  last_deleted bigint,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);
insert into public.trace_retention (id) values (true) on conflict (id) do nothing;

-- Read and written only through the functions below.
alter table public.trace_retention enable row level security;
revoke all on table public.trace_retention from anon, authenticated;
drop policy if exists trace_retention_oauth_no_insert on public.trace_retention;
create policy trace_retention_oauth_no_insert on public.trace_retention
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists trace_retention_oauth_no_update on public.trace_retention;
create policy trace_retention_oauth_no_update on public.trace_retention
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists trace_retention_oauth_no_delete on public.trace_retention;
create policy trace_retention_oauth_no_delete on public.trace_retention
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- The sweep asks by age alone; the other indexes all lead with an id.
create index if not exists turn_traces_created on public.turn_traces (created_at);

-- Deletes traces older than the kept days, a batch at a time, until done
-- or out of time; what is left goes on the next run. p_force runs it
-- with the switch off, for the administrator's "now". Nobody calls this
-- directly: the daily job runs as its owner, the button goes through
-- abo_admin_sweep_traces.
create or replace function public.abo_trace_sweep(p_budget_ms integer default 120000, p_force boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r     public.trace_retention;
  v_cut   timestamptz;
  v_start timestamptz := clock_timestamp();
  v_n     integer;
  v_total bigint := 0;
  v_more  boolean := false;
begin
  select * into v_r from public.trace_retention where id;
  if not found or (not v_r.enabled and not p_force) then
    return jsonb_build_object('deleted', 0, 'more', false, 'skipped', true);
  end if;
  v_cut := now() - make_interval(days => v_r.days);
  loop
    delete from public.turn_traces
     where id in (select id from public.turn_traces where created_at < v_cut limit 2000);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < 2000;
    if clock_timestamp() - v_start > make_interval(secs => p_budget_ms / 1000.0) then
      v_more := true;
      exit;
    end if;
  end loop;
  update public.trace_retention set last_run_at = now(), last_deleted = v_total where id;
  return jsonb_build_object('deleted', v_total, 'more', v_more, 'before', v_cut);
end $$;
revoke all on function public.abo_trace_sweep(integer, boolean) from public, anon, authenticated;

-- The settings, and what they would do today: how many traces are past
-- the kept days (counted to 100,001, which is enough to say "over"),
-- the oldest one, and the room they take.
create or replace function public.abo_admin_retention() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_r public.trace_retention;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select * into v_r from public.trace_retention where id;
  return jsonb_build_object(
    'enabled', v_r.enabled,
    'days', v_r.days,
    'last_run_at', v_r.last_run_at,
    'last_deleted', v_r.last_deleted,
    'updated_at', v_r.updated_at,
    'updated_by', (select u.email from auth.users u where u.id = v_r.updated_by),
    'past', (select count(*) from (
               select 1 from public.turn_traces
                where created_at < now() - make_interval(days => v_r.days) limit 100001) x),
    'oldest', (select min(created_at) from public.turn_traces),
    'bytes', pg_total_relation_size('public.turn_traces'),
    'scheduled', exists (select 1 from pg_extension where extname = 'pg_cron'));
end $$;
revoke all on function public.abo_admin_retention() from public, anon;
grant execute on function public.abo_admin_retention() to authenticated;

create or replace function public.abo_admin_set_retention(p_enabled boolean, p_days integer) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_enabled is null or p_days is null or p_days not between 7 and 3650 then
    raise exception 'Keep traces for 7 to 3650 days.' using errcode = '22023';
  end if;
  update public.trace_retention
     set enabled = p_enabled, days = p_days, updated_at = now(), updated_by = auth.uid()
   where id;
  return public.abo_admin_retention();
end $$;
revoke all on function public.abo_admin_set_retention(boolean, integer) from public, anon;
grant execute on function public.abo_admin_set_retention(boolean, integer) to authenticated;

-- "Delete older now": five seconds of it, inside the eight a request
-- gets, and says whether there is more.
create or replace function public.abo_admin_sweep_traces() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return public.abo_trace_sweep(5000, true);
end $$;
revoke all on function public.abo_admin_sweep_traces() from public, anon;
grant execute on function public.abo_admin_sweep_traces() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-trace-sweep', '17 3 * * *', 'select public.abo_trace_sweep()');
  end if;
end $$;

-- ── What administrators did ──────────────────────────────────
-- Every line of admin_account_audit across accounts, newest first: who
-- acted, on whose account, what changed. A word finds either address.
create index if not exists admin_account_audit_newest on public.admin_account_audit (created_at desc);

create or replace function public.abo_admin_access_log(
  p_query  text default null,
  p_action text default null,
  p_days   integer default 30,
  p_limit  integer default 100,
  p_before timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 3650));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc)
        from (
          select a.id, a.created_at, a.action, a.old_value, a.new_value,
                 a.actor_user_id as actor_id, ua.email as actor,
                 a.target_user_id as target_id, ut.email as target
            from public.admin_account_audit a
            left join auth.users ua on ua.id = a.actor_user_id
            left join auth.users ut on ut.id = a.target_user_id
           where a.created_at >= v_since
             and (p_before is null or a.created_at < p_before)
             and (p_action is null or a.action = p_action)
             and (v_q is null or ua.email ilike '%' || v_q || '%' or ut.email ilike '%' || v_q || '%')
           order by a.created_at desc, a.id desc
           limit v_limit
        ) r), '[]'::jsonb),
    -- How often each kind happened in the window, for the filter.
    'actions', coalesce((
      select jsonb_object_agg(x.action, x.n)
        from (select action, count(*) as n from public.admin_account_audit
               where created_at >= v_since group by action) x), '{}'::jsonb));
end $$;
revoke all on function public.abo_admin_access_log(text, text, integer, integer, timestamptz) from public, anon;
grant execute on function public.abo_admin_access_log(text, text, integer, integer, timestamptz) to authenticated;

-- ── What Luke cost ───────────────────────────────────────────
-- From the traces' priced usage: each day (UTC), each model (a turn's
-- calls are split by the model that made them), and the accounts that
-- spent most. "partial" counts turns with a call whose price was not
-- known, so their dollars are short.
create or replace function public.abo_admin_spend(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_days  integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
                         - make_interval(days => v_days - 1);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return (
    with t as (
      select tt.created_at, tt.usage, p.owner_id,
             coalesce((tt.usage ->> 'usd')::numeric, 0) as usd,
             coalesce((tt.usage ->> 'partial')::boolean, false) as partial
        from public.turn_traces tt
        join public.projects p on p.id = tt.project_id
       where tt.created_at >= v_since
    ),
    uses as (
      select x ->> 'model' as model, coalesce((x ->> 'usd')::numeric, 0) as usd,
             coalesce((x ->> 'input')::bigint, 0) as input, coalesce((x ->> 'output')::bigint, 0) as output
        from t, jsonb_array_elements(case when jsonb_typeof(t.usage -> 'uses') = 'array'
                                          then t.usage -> 'uses' else '[]'::jsonb end) x
    )
    select jsonb_build_object(
      'since', v_since,
      'total', (select jsonb_build_object('usd', coalesce(sum(usd), 0), 'turns', count(*),
                                          'accounts', count(distinct owner_id),
                                          'partial', count(*) filter (where partial)) from t),
      'days', (select coalesce(jsonb_agg(jsonb_build_object('day', to_char(d at time zone 'utc', 'YYYY-MM-DD'),
                                                            'usd', coalesce(x.usd, 0), 'turns', coalesce(x.turns, 0))
                                         order by d), '[]'::jsonb)
                 from generate_series(v_since, v_since + make_interval(days => v_days - 1), interval '1 day') d
                 left join (select date_trunc('day', created_at at time zone 'utc') at time zone 'utc' as day,
                                   sum(usd) as usd, count(*) as turns
                              from t group by 1) x on x.day = d),
      'models', (select coalesce(jsonb_agg(jsonb_build_object('model', m.model, 'usd', m.usd, 'calls', m.calls,
                                                              'input', m.input, 'output', m.output)
                                           order by m.usd desc), '[]'::jsonb)
                   from (select coalesce(model, 'unknown') as model, sum(usd) as usd, count(*) as calls,
                                sum(input) as input, sum(output) as output
                           from uses group by 1) m),
      'accounts', (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.owner_id, 'email', u.email,
                                                                'usd', a.usd, 'turns', a.turns)
                                             order by a.usd desc), '[]'::jsonb)
                     from (select owner_id, sum(usd) as usd, count(*) as turns
                             from t group by owner_id order by sum(usd) desc limit 20) a
                     left join auth.users u on u.id = a.owner_id),
      'kept_from', (select min(created_at) from public.turn_traces))
  );
end $$;
revoke all on function public.abo_admin_spend(integer) from public, anon;
grant execute on function public.abo_admin_spend(integer) to authenticated;

-- ── Finding things by a word ─────────────────────────────────
-- The console's searches are "contains" (ilike '%…%'), which a btree
-- cannot help; a trigram index can, from three letters up. Addresses
-- live in auth.users, which is not ours to index.
create extension if not exists pg_trgm with schema extensions;
create index if not exists conversations_title_trgm on public.conversations using gin (title extensions.gin_trgm_ops);
create index if not exists projects_name_trgm on public.projects using gin (name extensions.gin_trgm_ops);
create index if not exists stores_shop_domain_trgm on public.stores using gin (shop_domain extensions.gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
