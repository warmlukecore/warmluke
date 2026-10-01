-- Migration 0154: a store brings the history it was asked for
--
-- A store brought in everything Shopify would hand over. Without
-- read_all_orders that is sixty days of orders; with it, a large store's
-- whole life, and its every customer, before the merchant had said what
-- they wanted. Now they choose how far back orders and customers go —
-- 30, 60, 90, 180 or 365 days — and products come in full whatever they
-- choose. New orders keep arriving by webhook regardless.
--
-- The window is a moment, not a date: midnight in the store's own
-- timezone, so "the last 30 days" means the merchant's days. Shopify is
-- asked only for what falls inside it (lib/shopify-resources, windowed),
-- and nothing here forgets a row for being outside it: a row from before
-- the window is one the window never asked about, not one Shopify lost.
--
-- A store that has not chosen waits for orders and customers until it
-- does, and for fifteen minutes at most; then it takes sixty days, which
-- is what Shopify gives without read_all_orders anyway. Every store
-- connected before this keeps what it had: chosen, and everything.

-- ── The window ─────────────────────────────────────────────
-- history_from was a date nothing ever wrote. It becomes the moment
-- the window opens; null is "everything Shopify gives".
alter table public.stores alter column history_from type timestamptz using history_from::timestamptz;
alter table public.stores add column if not exists history_days integer;
-- Any whole number of days an administrator offers (history_settings).
alter table public.stores drop constraint if exists stores_history_days_check;
alter table public.stores add constraint stores_history_days_check
  check (history_days is null or history_days between 1 and 3650);
-- When it was chosen; null for a store still to be asked.
alter table public.stores add column if not exists history_set_at timestamptz;

update public.stores set history_set_at = coalesce(connected_at, created_at, now()) where history_set_at is null;

-- A signed-in reader is granted the store's columns one by one (0065,
-- 0102) so the token columns are never among them; a column added
-- without its grant fails every read that names it, Luke's included.
grant select (history_days, history_set_at) on public.stores to authenticated;

-- Chosen unless a merchant is to be asked: a row written any other way
-- (a fixture, a script, a store moved between projects) has the
-- everything it always had. Only a store's first connection, below,
-- leaves it to be asked.
alter table public.stores alter column history_set_at set default now();

-- ── A store's first connection is the one that asks ──────────
-- 0102's connect, with one more column: a row that has never been
-- connected comes back from Shopify not yet chosen, so its merchant is
-- asked how far back to go. A reconnect keeps what was chosen.
create or replace function public.abo_shopify_connect(
  p_state              text,
  p_shop               text,
  p_token              text,
  p_timezone           text,
  p_currency           text,
  p_country            text,
  p_refresh_token      text,
  p_expires_in         integer,
  p_refresh_expires_in integer,
  p_scopes             text[] default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  update public.stores
     set access_token             = p_token,
         refresh_token            = p_refresh_token,
         token_expires_at         = case when p_expires_in is null then null
                                    else now() + make_interval(secs => p_expires_in) end,
         refresh_token_expires_at = case when p_refresh_expires_in is null then null
                                    else now() + make_interval(secs => p_refresh_expires_in) end,
         timezone                 = coalesce(p_timezone, 'UTC'),
         currency                 = coalesce(p_currency, 'INR'),
         country                  = p_country,
         granted_scopes           = coalesce(p_scopes, stores.granted_scopes),
         -- Read before this statement sets connected_at: never connected
         -- before means not asked yet.
         history_set_at           = case
                                      when stores.connected_at is null
                                       and coalesce((select h.enabled from public.history_settings h where h.id), true)
                                      then null
                                      else stores.history_set_at
                                    end,
         status                   = 'connected',
         connected_at             = now(),
         oauth_state              = null,
         oauth_state_expires_at   = null
   where oauth_state = p_state
     and oauth_state_expires_at > now()
     and lower(shop_domain) = lower(p_shop)
   returning project_id into v_project;

  return v_project;  -- null: unknown, used, expired, or a different shop
end $$;
revoke all on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer, text[]) from public;
grant execute on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer, text[]) to anon, authenticated;

-- ── What is offered, as an administrator sets it ───────────
-- One row: whether merchants are asked at all, the windows they may
-- choose from, and the one preselected and taken by a store whose
-- merchant never answers. Read by anybody (it says nothing private: the
-- picker, the import and its worker all need it); written only through
-- abo_admin_set_history_settings. Off, nobody is asked and a new store
-- brings everything Shopify shares; a window already chosen stays.
create table if not exists public.history_settings (
  id           boolean primary key default true check (id),
  enabled      boolean not null default true,
  choices      integer[] not null default '{30,60,90,180,365}',
  default_days integer not null default 60,
  updated_at   timestamptz not null default now(),
  check (cardinality(choices) between 1 and 12),
  check (1 <= all (choices) and 3650 >= all (choices)),
  check (default_days = any (choices))
);
insert into public.history_settings (id) values (true) on conflict (id) do nothing;

alter table public.history_settings enable row level security;
revoke all on table public.history_settings from anon, authenticated;
grant select on table public.history_settings to anon, authenticated;
drop policy if exists history_settings_read on public.history_settings;
create policy history_settings_read on public.history_settings for select to anon, authenticated using (true);
drop policy if exists history_settings_oauth_no_insert on public.history_settings;
create policy history_settings_oauth_no_insert on public.history_settings
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists history_settings_oauth_no_update on public.history_settings;
create policy history_settings_oauth_no_update on public.history_settings
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists history_settings_oauth_no_delete on public.history_settings;
create policy history_settings_oauth_no_delete on public.history_settings
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

create or replace function public.abo_admin_set_history_settings(p_enabled boolean, p_choices integer[], p_default integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_choices integer[];
  v_row     public.history_settings;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Change this in Warmluke itself.' using errcode = '42501';
  end if;
  -- In order and once each, whatever order they were typed in.
  v_choices := array(select distinct d from unnest(coalesce(p_choices, '{}')) d where d is not null order by d);
  if cardinality(v_choices) = 0 then
    raise exception 'Offer at least one window.' using errcode = '22023';
  end if;
  if cardinality(v_choices) > 12 then
    raise exception 'Twelve windows at most.' using errcode = '22023';
  end if;
  if v_choices[1] < 1 or v_choices[cardinality(v_choices)] > 3650 then
    raise exception 'Each window is between 1 and 3650 days.' using errcode = '22023';
  end if;
  if p_default is null or not (p_default = any (v_choices)) then
    raise exception 'The default has to be one of the windows offered.' using errcode = '22023';
  end if;
  update public.history_settings
     set enabled = coalesce(p_enabled, true), choices = v_choices, default_days = p_default, updated_at = now()
   where id
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.abo_admin_set_history_settings(boolean, integer[], integer) from public, anon;
grant execute on function public.abo_admin_set_history_settings(boolean, integer[], integer) to authenticated;

-- A removed order sets its draft's link to null, one draft lookup per
-- order; without this that lookup is a scan of every draft.
create index if not exists draft_orders_order_id on public.draft_orders (order_id) where order_id is not null;

-- ── Midnight, so many days ago, in a store's own timezone ─────
-- One answer for the picker's counts and for the choice itself, so the
-- window a count describes is the window that is then imported.
create or replace function public.abo_days_ago(p_tz text, p_days integer[])
returns timestamptz[]
language sql stable set search_path = public as $$
  with tz as (
    select case when exists (select 1 from pg_timezone_names where name = p_tz) then p_tz else 'UTC' end as name
  )
  select array_agg(
           ((((now() at time zone tz.name)::date - d)::timestamp) at time zone tz.name)
           order by o)
    from tz, unnest(p_days) with ordinality as u(d, o)
$$;
revoke all on function public.abo_days_ago(text, integer[]) from public, anon;
grant execute on function public.abo_days_ago(text, integer[]) to authenticated;

-- ── Choosing ───────────────────────────────────────────────
-- The resources the window applies to. lib/shopify-resources WINDOWED
-- names the same five; check-shopify compares them. The days on offer
-- are history_settings', so a merchant chooses only what is offered.
create or replace function public.abo_store_set_history(p_store uuid, p_days integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store    public.stores;
  v_set      public.history_settings;
  v_from     timestamptz;
  v_moved    boolean;
  v_extend   boolean;
  v_older    integer;
  v_windowed text[] := array['customers', 'returns', 'orders', 'refunds', 'fulfillments'];
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Choose this in Warmluke itself.' using errcode = '42501';
  end if;
  select * into v_set from public.history_settings where id;
  if not coalesce(v_set.enabled, true) then
    raise exception 'Choosing how far back is switched off.' using errcode = '22023';
  end if;
  if p_days is null or not (p_days = any (coalesce(v_set.choices, '{30,60,90,180,365}'))) then
    raise exception 'Choose one of: % days.', array_to_string(coalesce(v_set.choices, '{30,60,90,180,365}'), ', ')
      using errcode = '22023';
  end if;
  select * into v_store from public.stores where id = p_store for update;
  if not found or not public.abo_owns(v_store.project_id) then
    raise exception 'not a store of yours' using errcode = '42501';
  end if;

  v_from := (public.abo_days_ago(v_store.timezone, array[p_days]))[1];

  -- Read again with the new start when the lists have already been
  -- walked with a later one (or with the sixty-day fallback, before
  -- anybody chose): every write is an upsert on the Shopify id, so the
  -- pass costs time and duplicates nothing. A shorter window needs no
  -- pass: what is held stays until the merchant says otherwise.
  v_moved := exists (
    select 1 from public.import_runs
     where store_id = p_store and resource = any(v_windowed) and status <> 'pending'
  );
  v_extend := v_moved and (
    v_store.history_set_at is null
    or (v_store.history_from is not null and v_from < v_store.history_from)
  );

  update public.stores
     set history_from = v_from, history_days = p_days, history_set_at = now()
   where id = p_store;

  if v_extend then
    update public.import_runs
       set status = 'pending', cursor = null, imported = 0, started_at = now(),
           finished_at = null, attempts = 0, retry_at = null, error = null
     where store_id = p_store and resource = any(v_windowed);
  end if;

  -- What a shorter window leaves outside it, counted up to a bound: the
  -- merchant is asked whether to keep it, and "over a hundred thousand"
  -- answers that as well as the exact figure would.
  select count(*) into v_older from (
    select 1 from public.orders where store_id = p_store and placed_at < v_from limit 100001
  ) x;

  return jsonb_build_object('from', v_from, 'days', p_days, 'extended', v_extend, 'older', v_older);
end $$;
revoke all on function public.abo_store_set_history(uuid, integer) from public, anon;
grant execute on function public.abo_store_set_history(uuid, integer) to authenticated;

-- ── Letting go of what is outside it, when asked ───────────
-- A batch at a time: a store with a million old orders would otherwise
-- be one statement that outlives the timeout. The caller asks again
-- until a batch comes back short. Lines, payments, refunds, shipments
-- and returns go with their order (on delete cascade); customers stay,
-- their lifetime totals are Shopify's and do not depend on these rows.
create or replace function public.abo_store_trim_history(p_store uuid, p_batch integer default 2000)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store public.stores;
  v_n     integer;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Choose this in Warmluke itself.' using errcode = '42501';
  end if;
  select * into v_store from public.stores where id = p_store;
  if not found or not public.abo_owns(v_store.project_id) then
    raise exception 'not a store of yours' using errcode = '42501';
  end if;
  if v_store.history_from is null then
    return 0;
  end if;
  delete from public.orders
   where id in (
     select id from public.orders
      where store_id = p_store and placed_at < v_store.history_from
      limit least(greatest(coalesce(p_batch, 2000), 1), 5000)
   );
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.abo_store_trim_history(uuid, integer) from public, anon;
grant execute on function public.abo_store_trim_history(uuid, integer) to authenticated;

-- ── Forgetting only inside the window ──────────────────────
-- 0124's body, with the window: an order from before it was never asked
-- for, so its absence from a pass says nothing. Customers carry no date
-- of their own here to hold to a window, so a windowed store forgets
-- none; a customer Shopify erases still goes by the redact webhook.
create or replace function public.abo_store_forget_unseen(p_store uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_all_orders boolean;
  v_from       timestamptz;
  r            record;
  v_table      text;
  v_n          integer;
  v_out        jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select 'read_all_orders' = any(coalesce(s.granted_scopes, '{}')), s.history_from
    into v_all_orders, v_from
    from public.stores s
   where s.id = p_store and public.abo_owns(s.project_id);
  if not found then
    raise exception 'not a store of yours';
  end if;

  delete from public.store_row_tombstones where store_id = p_store and removed_at < now() - interval '90 days';

  for r in
    select resource, prev_started_at, finished_at from public.import_runs
     where store_id = p_store and status = 'done' and prev_started_at is not null and finished_at is not null
  loop
    v_table := case r.resource
      when 'products' then 'products'
      when 'collections' then 'collections'
      when 'customers' then 'customers'
      when 'drafts' then 'draft_orders'
      when 'discounts' then 'discounts'
      when 'orders' then 'orders'
      when 'locations' then 'locations'
    end;
    continue when v_table is null;
    continue when v_table = 'customers' and v_from is not null;
    execute format(
      'with gone as (
         delete from public.%I
          where store_id = $1 and created_at <= $2 and (seen_at is null or seen_at < $2)'
        || case when v_table = 'orders' and not v_all_orders then ' and placed_at >= $3' else '' end
        || case when v_table = 'orders' and v_from is not null then ' and placed_at >= $4' else '' end
        || ' returning id, external_id
       )
       insert into public.store_row_tombstones (store_id, table_name, external_id, row_id)
       select $1, %L, external_id, id from gone
       on conflict (store_id, table_name, external_id)
         do update set row_id = excluded.row_id, removed_at = now()',
      v_table, v_table
    ) using p_store, r.prev_started_at, r.finished_at - interval '59 days', v_from;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_out := v_out || jsonb_build_object(r.resource, v_n);
    end if;
  end loop;
  return v_out;
end $$;

revoke all on function public.abo_store_forget_unseen(uuid) from public, anon;
grant execute on function public.abo_store_forget_unseen(uuid) to authenticated;

-- ── The worker learns the window with the token ────────────
-- Its ticket reaches no stores row, so what it may import has to come
-- with what it is handed. 0110's function, three columns longer.
drop function if exists public.abo_import_store();
create function public.abo_import_store()
returns table (
  id                       uuid,
  shop_domain              text,
  status                   text,
  last_synced_at           timestamptz,
  access_token             text,
  refresh_token            text,
  token_expires_at         timestamptz,
  refresh_token_expires_at timestamptz,
  connected_at             timestamptz,
  history_from             timestamptz,
  history_set_at           timestamptz
)
language sql stable security definer set search_path = public as $$
  select s.id, s.shop_domain, s.status, s.last_synced_at,
         s.access_token, s.refresh_token, s.token_expires_at, s.refresh_token_expires_at,
         s.connected_at, s.history_from, s.history_set_at
    from public.import_leases l
    join public.stores s on s.id = l.store_id
   where l.expires_at > now()
     and l.ticket_hash = public.abo_import_ticket_hash()
     and s.status = 'connected'
$$;
revoke all on function public.abo_import_store() from public, authenticated;
grant execute on function public.abo_import_store() to anon;

-- ── The tick leaves a store alone while its merchant chooses ───
-- 0110's tick, with one more condition: a store still to be asked, and
-- connected under fifteen minutes ago, has nothing the worker could do
-- for its orders yet, and sending it would only wake the worker to say
-- so every minute. lib/import-step HISTORY_WAIT_MS is the same fifteen.
create or replace function public.abo_import_tick()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_store uuid;
  v_sent  integer := 0;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'import_worker_url') then
    return 0;
  end if;
  for v_store in
    select s.id
      from public.stores s
     where s.status = 'connected'
       and not (
         s.history_set_at is null and s.connected_at > now() - interval '15 minutes'
         and coalesce((select h.enabled from public.history_settings h where h.id), true)
       )
       and not exists (
         select 1 from public.import_leases l where l.store_id = s.id and l.expires_at > now()
       )
       and (
         not exists (select 1 from public.import_runs r where r.store_id = s.id)
         or exists (
           select 1 from public.import_runs r
            where r.store_id = s.id
              and (
                r.status in ('pending', 'running')
                or (r.status = 'failed' and r.retry_at is not null and r.retry_at <= now())
              )
         )
       )
     order by s.connected_at nulls first
     limit 200
  loop
    if public.abo_import_dispatch(v_store) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

NOTIFY pgrst, 'reload schema';
