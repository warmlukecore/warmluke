-- The import that needs no tab.
--
-- A store's first import ran only while its merchant watched: the
-- browser asked for one page at a time, and a closed laptop stopped it
-- halfway. It has to run on the server. But everything the importer
-- writes is written as the merchant, under the policies that keep one
-- store's rows away from every other, and a server job has no merchant
-- session. Nothing on the server holds a key that could stand in for
-- one, on purpose.
--
-- So this database hands out the authority itself, one job at a time.
-- When a store has import work it mints a ticket — random, bound to
-- that one store, a few minutes long — keeps only its hash, and sends
-- the ticket to the worker route with pg_net. The worker presents it
-- on every request as the x-import-ticket header, and the policies
-- below accept it for that store's commerce rows and nothing else: no
-- accounts, no projects, no sections, no other store. There is no
-- standing secret on the server to leak; a ticket is useless once it
-- lapses, and useless for any other store while it lives.
--
-- The worker's address is the switch. With no import_worker_url in
-- the vault — the check project, or production turned back — nothing
-- is dispatched and the browser drives the import the way it did.

create extension if not exists pg_net;

-- ── Retrying without hammering ───────────────────────────────────
-- A failed page used to be retried by whoever was watching. With
-- nobody watching, the worker waits between tries and stops after a
-- few; when to try again is decided where the error was (the import
-- step), and the tick only honours it.
alter table public.import_runs
  add column if not exists attempts integer not null default 0,
  add column if not exists retry_at timestamptz;

-- ── The claim ────────────────────────────────────────────────────
-- One row per store is the whole lock: a second ticket cannot be
-- minted while the first lives, so two workers never walk one store.
create table if not exists public.import_leases (
  store_id    uuid primary key references public.stores(id) on delete cascade,
  ticket_hash bytea not null,
  expires_at  timestamptz not null,
  taken_at    timestamptz not null default now()
);
alter table public.import_leases enable row level security;
-- No permissive policies: reached only through the functions below.
revoke all on public.import_leases from anon, authenticated;
-- And the wall every table has, whatever else it has: no write from a
-- connected client's token (check-rls asks abo_tables_missing_oauth_guard).
drop policy if exists import_leases_oauth_no_insert on public.import_leases;
create policy import_leases_oauth_no_insert on public.import_leases
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists import_leases_oauth_no_update on public.import_leases;
create policy import_leases_oauth_no_update on public.import_leases
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists import_leases_oauth_no_delete on public.import_leases;
create policy import_leases_oauth_no_delete on public.import_leases
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

/** The hash of the ticket this request carries, or null. */
create or replace function public.abo_import_ticket_hash()
returns bytea
language sql stable set search_path = public as $$
  select sha256(convert_to(h.t, 'UTF8'))
    from (
      select nullif(current_setting('request.headers', true), '')::json ->> 'x-import-ticket' as t
    ) h
   where h.t is not null and length(h.t) >= 32
$$;

/** Whether this request's ticket is live and bound to store s. */
create or replace function public.abo_import_holds(s uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.import_leases l
     where l.store_id = s
       and l.expires_at > now()
       and l.ticket_hash = public.abo_import_ticket_hash()
  )
$$;

/**
 * A fresh ticket for a connected store, or null while another lives.
 * Internal: only this database's own functions mint.
 */
create or replace function public.abo_import_mint(p_store uuid, p_seconds integer default 360)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ticket text;
  v_got    uuid;
begin
  if not exists (select 1 from public.stores where id = p_store and status = 'connected') then
    return null;
  end if;
  -- Two v4 uuids: 244 random bits, from the same source gen_random_uuid
  -- already trusts, with no extension to depend on.
  v_ticket := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.import_leases as l (store_id, ticket_hash, expires_at)
  values (p_store, sha256(convert_to(v_ticket, 'UTF8')), now() + make_interval(secs => p_seconds))
  on conflict (store_id) do update
     set ticket_hash = excluded.ticket_hash,
         expires_at  = excluded.expires_at,
         taken_at    = now()
   where l.expires_at <= now()
  returning l.store_id into v_got;
  return case when v_got is null then null else v_ticket end;
end $$;

/**
 * Sends a store's import to the worker: 'sent', 'busy' (a ticket
 * lives), 'not_connected', or 'not_configured' (no worker address,
 * so the browser drives it). Internal.
 */
create or replace function public.abo_import_dispatch(p_store uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_url    text;
  v_ticket text;
begin
  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds
   where ds.name = 'import_worker_url'
   limit 1;
  if v_url is null or v_url = '' then
    return 'not_configured';
  end if;
  if not exists (select 1 from public.stores where id = p_store and status = 'connected') then
    return 'not_connected';
  end if;
  v_ticket := public.abo_import_mint(p_store);
  if v_ticket is null then
    return 'busy';
  end if;
  -- Queued, not sent: pg_net posts after this transaction commits, so
  -- a connect that rolls back sends nothing.
  perform net.http_post(
    url                  := v_url,
    body                 := jsonb_build_object('store', p_store, 'ticket', v_ticket),
    headers              := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  );
  return 'sent';
end $$;

-- ── What a ticket may do ─────────────────────────────────────────

/** The store this request's ticket is for, token included. */
create or replace function public.abo_import_store()
returns table (
  id                       uuid,
  shop_domain              text,
  status                   text,
  last_synced_at           timestamptz,
  access_token             text,
  refresh_token            text,
  token_expires_at         timestamptz,
  refresh_token_expires_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select s.id, s.shop_domain, s.status, s.last_synced_at,
         s.access_token, s.refresh_token, s.token_expires_at, s.refresh_token_expires_at
    from public.import_leases l
    join public.stores s on s.id = l.store_id
   where l.expires_at > now()
     and l.ticket_hash = public.abo_import_ticket_hash()
     and s.status = 'connected'
$$;

/**
 * Keeps a live ticket alive while its worker is busy. Bounded twice:
 * no more than ten minutes at a time, and never past half an hour
 * from when it was minted — a worker that has more to do hands over
 * to a fresh ticket instead (abo_import_continue).
 */
create or replace function public.abo_import_renew(p_seconds integer default 360)
returns boolean
language sql volatile security definer set search_path = public as $$
  with renewed as (
    update public.import_leases
       set expires_at = now() + make_interval(secs => least(greatest(p_seconds, 30), 600))
     where expires_at > now()
       and taken_at > now() - interval '30 minutes'
       and ticket_hash = public.abo_import_ticket_hash()
    returning 1
  )
  select exists (select 1 from renewed)
$$;

/** Gives the ticket back: the store is free for the next dispatch. */
create or replace function public.abo_import_release()
returns void
language sql volatile security definer set search_path = public as $$
  delete from public.import_leases where ticket_hash = public.abo_import_ticket_hash()
$$;

/**
 * Hands the rest of the work to a fresh ticket and a fresh request,
 * so one run never outlives its function. Returns what dispatch said.
 */
create or replace function public.abo_import_continue()
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_store uuid;
begin
  delete from public.import_leases
   where expires_at > now()
     and ticket_hash = public.abo_import_ticket_hash()
  returning store_id into v_store;
  if v_store is null then
    return 'no_ticket';
  end if;
  return public.abo_import_dispatch(v_store);
end $$;

-- The tables a ticket reaches: every table the importer writes — the
-- tables of every resource in lib/shopify-resources, which
-- check-import-worker holds this list to — and the progress it keeps.
-- Not shopify_data_requests, not store_actions, not stores.
do $$
declare t text;
begin
  foreach t in array array[
    'abandoned_checkouts', 'collection_products', 'collections', 'customers', 'discounts',
    'draft_order_line_items', 'draft_orders', 'fulfillments', 'inventory_levels', 'locations',
    'order_line_items', 'order_transactions', 'orders', 'payouts', 'products', 'refunds',
    'return_line_items', 'returns', 'variants',
    'import_runs'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_import_ticket', t);
    execute format(
      'create policy %I on public.%I for all to anon '
      'using (public.abo_import_holds(store_id)) with check (public.abo_import_holds(store_id))',
      t || '_import_ticket', t
    );
  end loop;
end $$;

-- ── The two writes the importer makes to the store row ───────────

/**
 * A renewed Shopify token, stored by the owner or by the ticket for
 * this store. Replaces the direct update the importer made as the
 * owner: a ticket must not reach the row itself, which names the
 * project a store belongs to.
 */
create or replace function public.abo_store_renewed(
  p_store                    uuid,
  p_access_token             text,
  p_refresh_token            text,
  p_token_expires_at         timestamptz,
  p_refresh_token_expires_at timestamptz,
  p_scopes                   text[] default null
) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_ok boolean;
begin
  if public.abo_is_oauth_client() then
    raise exception 'A connected client cannot change the store token.' using errcode = '42501';
  end if;
  if p_access_token is null or p_access_token = '' then
    raise exception 'There is no token to store.' using errcode = '22023';
  end if;
  update public.stores s
     set access_token             = p_access_token,
         -- Every refresh returns a new refresh token and spends the
         -- old one; kept only when Shopify said nothing about it.
         refresh_token            = coalesce(p_refresh_token, s.refresh_token),
         token_expires_at         = p_token_expires_at,
         refresh_token_expires_at = coalesce(p_refresh_token_expires_at, s.refresh_token_expires_at),
         -- Omitted, not nulled, when the renewal is silent about them.
         granted_scopes           = coalesce(p_scopes, s.granted_scopes)
   where s.id = p_store
     and (
       public.abo_import_holds(s.id)
       or (auth.uid() is not null and public.abo_owns(s.project_id))
     )
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

/** The forward-only sync stamp, open to the ticket for its store too. */
create or replace function public.abo_store_synced(p_store uuid, p_at timestamptz)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if p_at is null then
    return null;
  end if;
  update public.stores
     set last_synced_at = greatest(coalesce(last_synced_at, p_at), p_at)
   where id = p_store
     and (public.abo_owns(project_id) or public.abo_import_holds(id))
  returning last_synced_at into v_at;
  return v_at;
end $$;

-- ── Who dispatches ───────────────────────────────────────────────

/**
 * Every minute: each connected store with work left and nobody on it.
 * Work left is a resource not yet done, or one that failed and whose
 * wait is over; a store with no progress at all has not started.
 * ponytail: 200 stores a minute, dispatched in turn; a queue when
 * more than that are importing at once.
 */
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

/**
 * Once a day: every connected store with nobody on it. The worker
 * knows the registry and this database does not, so a resource added
 * after a store finished is noticed there — it finds no progress for
 * it, and starts it. A store with nothing new is released at once.
 */
create or replace function public.abo_import_sweep()
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
       and not exists (
         select 1 from public.import_leases l where l.store_id = s.id and l.expires_at > now()
       )
     limit 1000
  loop
    if public.abo_import_dispatch(v_store) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

/**
 * The owner's own "start it now": after connecting, after "check for
 * changes", after "try again". Their assistant may ask too — asking
 * starts their own import and hands it nothing.
 */
create or replace function public.abo_import_kick(p_store uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.stores s where s.id = p_store and public.abo_owns(s.project_id)) then
    raise exception 'That store is not yours.' using errcode = '42501';
  end if;
  return public.abo_import_dispatch(p_store);
end $$;

/**
 * The moment a store connects, its import starts — whoever is looking.
 * A dispatch that fails must not fail the connect: the merchant's code
 * from Shopify is already spent, and the tick picks the store up
 * within the minute anyway.
 */
create or replace function public.abo_import_on_connect()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'connected' and old.status is distinct from 'connected' then
    begin
      perform public.abo_import_dispatch(new.id);
    exception when others then
      raise warning 'import dispatch on connect failed for %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end $$;

drop trigger if exists stores_import_on_connect on public.stores;
create trigger stores_import_on_connect
  after update of status on public.stores
  for each row execute function public.abo_import_on_connect();

-- ── Grants ───────────────────────────────────────────────────────
revoke all on function public.abo_import_ticket_hash() from public;
revoke all on function public.abo_import_holds(uuid) from public;
revoke all on function public.abo_import_mint(uuid, integer) from public, anon, authenticated;
revoke all on function public.abo_import_dispatch(uuid) from public, anon, authenticated;
revoke all on function public.abo_import_tick() from public, anon, authenticated;
revoke all on function public.abo_import_sweep() from public, anon, authenticated;
revoke all on function public.abo_import_on_connect() from public, anon, authenticated;
-- The worker is anon plus a ticket, and nothing else: a signed-in
-- merchant has no ticket to present, so these are not theirs either.
revoke all on function public.abo_import_store() from public, authenticated;
revoke all on function public.abo_import_renew(integer) from public, authenticated;
revoke all on function public.abo_import_release() from public, authenticated;
revoke all on function public.abo_import_continue() from public, authenticated;
revoke all on function public.abo_import_kick(uuid) from public, anon;
revoke all on function public.abo_store_renewed(uuid, text, text, timestamptz, timestamptz, text[]) from public;
revoke all on function public.abo_store_synced(uuid, timestamptz) from public;

-- The policies call these as whoever is asking.
grant execute on function public.abo_import_ticket_hash() to anon, authenticated;
grant execute on function public.abo_import_holds(uuid) to anon, authenticated;
-- The worker, which is anon plus a ticket.
grant execute on function public.abo_import_store() to anon;
grant execute on function public.abo_import_renew(integer) to anon;
grant execute on function public.abo_import_release() to anon;
grant execute on function public.abo_import_continue() to anon;
-- The owner.
grant execute on function public.abo_import_kick(uuid) to authenticated;
-- Both.
grant execute on function public.abo_store_renewed(uuid, text, text, timestamptz, timestamptz, text[]) to anon, authenticated;
grant execute on function public.abo_store_synced(uuid, timestamptz) to anon, authenticated;

-- ── The clock ────────────────────────────────────────────────────
-- Where pg_cron is installed (production). The check project has
-- none, and no worker address either, so it keeps the browser's way.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-import-tick', '* * * * *', 'select public.abo_import_tick()');
    perform cron.schedule('abo-import-sweep', '23 3 * * *', 'select public.abo_import_sweep()');
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
