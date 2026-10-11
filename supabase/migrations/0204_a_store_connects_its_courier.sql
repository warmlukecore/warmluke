-- Migration 0204: a store connects its courier
--
-- Connectors, phase 2 (docs/integrations/connectors.md, 11 Oct): the
-- shared part every connector uses, and the first list one brings.
--
-- - store_connections   one per store, provider and remote account. No
--                       secret is a column: the credential is in the
--                       vault as 'connector:<id>', never read back to a
--                       browser. The row says who connected and when,
--                       and who disconnected.
-- - connector_cursors   where each resource of a connection got to.
-- - connector_leases    the claim and its ticket's hash, as import_leases.
-- - courier_shipments   one per connection and shipment: its AWB, courier,
--                       status, delivery and money, and the Shopify order
--                       it is for, matched here once, on write.
--
-- Only the owner connects or disconnects (abo_owns), never from their AI's
-- token. Whoever may open the store reads its connections and shipments,
-- as its orders (abo_store_readable). Background sync is a ticket per
-- connection, minted here and posted to the worker (0110's pattern): the
-- ticket reaches that connection's secret and rows, for minutes. The
-- switch is the vault entry connector_worker_url; the check project must
-- never have one.
--
-- ponytail: a shipment synced before its order arrived stays unmatched
-- until its next sync; add a trigger on orders if couriers outrun the import.

-- ── The connection ───────────────────────────────────────────
create table if not exists public.store_connections (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  store_id          uuid not null references public.stores(id) on delete cascade,
  provider          text not null check (provider in ('shiprocket', 'goswift', 'meta_ads', 'google_ads')),
  account_ref       text not null check (char_length(account_ref) between 1 and 200),
  account_label     text check (account_label is null or char_length(account_label) <= 200),
  status            text not null default 'connected' check (status in ('connected', 'needs_attention', 'disconnected')),
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  scopes            text[] not null default '{}',
  connected_by      uuid references auth.users(id) on delete set null,
  connected_at      timestamptz not null default now(),
  disconnected_by   uuid references auth.users(id) on delete set null,
  disconnected_at   timestamptz,
  last_synced_at    timestamptz,
  next_sync_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (store_id, provider, account_ref)
);
create index if not exists store_connections_due on public.store_connections (next_sync_at) where status = 'connected';

create table if not exists public.connector_cursors (
  connection_id  uuid not null references public.store_connections(id) on delete cascade,
  resource       text not null,
  cursor         text,
  synced_through timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (connection_id, resource)
);

create table if not exists public.connector_leases (
  connection_id uuid primary key references public.store_connections(id) on delete cascade,
  ticket_hash   bytea not null,
  expires_at    timestamptz not null,
  taken_at      timestamptz not null default now()
);

-- ── What a courier brings ────────────────────────────────────
create table if not exists public.courier_shipments (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  connection_id  uuid not null references public.store_connections(id) on delete cascade,
  provider       text not null,
  shipment_ref   text not null,
  awb            text,
  order_ref      text,
  order_id       uuid references public.orders(id) on delete set null,
  courier        text,
  status         text,
  status_at      timestamptz,
  ndr_reason     text,
  ndr_attempts   integer,
  rto            boolean not null default false,
  shipped_at     timestamptz,
  delivered_at   timestamptz,
  freight        numeric,
  cod_amount     numeric,
  payment_mode   text,
  track_url      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (connection_id, shipment_ref)
);
create index if not exists courier_shipments_store on public.courier_shipments (store_id, updated_at desc);
create index if not exists courier_shipments_order on public.courier_shipments (order_id) where order_id is not null;
create index if not exists courier_shipments_awb on public.courier_shipments (store_id, awb) where awb is not null;

-- ── Who reads, who writes ────────────────────────────────────
alter table public.store_connections enable row level security;
alter table public.connector_cursors enable row level security;
alter table public.connector_leases enable row level security;
alter table public.courier_shipments enable row level security;

drop policy if exists store_connections_member_read on public.store_connections;
create policy store_connections_member_read on public.store_connections
  for select to authenticated using (public.abo_store_readable(store_id));
drop policy if exists courier_shipments_member_read on public.courier_shipments;
create policy courier_shipments_member_read on public.courier_shipments
  for select to authenticated using (public.abo_store_readable(store_id));
-- Cursors and leases: through the functions below only.
revoke all on public.connector_cursors from anon, authenticated;
revoke all on public.connector_leases from anon, authenticated;
-- Rows are written by the functions below, never straight from a browser.
revoke insert, update, delete on public.store_connections from anon, authenticated;
revoke insert, update, delete on public.courier_shipments from anon, authenticated;

-- The wall every table has: no write from a connected client's token.
do $$
declare t text;
begin
  foreach t in array array['store_connections', 'connector_cursors', 'connector_leases', 'courier_shipments'] loop
    execute format('drop policy if exists %1$s_oauth_no_insert on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_insert on public.%1$s as restrictive for insert to authenticated with check (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_update on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_update on public.%1$s as restrictive for update to authenticated using (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_delete on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_delete on public.%1$s as restrictive for delete to authenticated using (not public.abo_is_oauth_client())', t);
  end loop;
end $$;

-- ── The ticket ───────────────────────────────────────────────
/** The hash of the ticket this request carries, or null. */
create or replace function public.abo_connector_ticket_hash()
returns bytea
language sql stable set search_path = public as $$
  select sha256(convert_to(h.t, 'UTF8'))
    from (
      select nullif(current_setting('request.headers', true), '')::json ->> 'x-connector-ticket' as t
    ) h
   where h.t is not null and length(h.t) >= 32
$$;

/** The connection this request's ticket is live for, or null. */
create or replace function public.abo_connector_held()
returns uuid
language sql stable security definer set search_path = public as $$
  select l.connection_id
    from public.connector_leases l
    join public.store_connections c on c.id = l.connection_id
   where l.expires_at > now()
     and l.ticket_hash = public.abo_connector_ticket_hash()
     and c.status = 'connected'
$$;

/** A fresh ticket for a connected connection, or null while another lives. Internal. */
create or replace function public.abo_connector_mint(p_connection uuid, p_seconds integer default 360)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ticket text;
  v_got    uuid;
begin
  if not exists (select 1 from public.store_connections where id = p_connection and status = 'connected') then
    return null;
  end if;
  v_ticket := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.connector_leases as l (connection_id, ticket_hash, expires_at)
  values (p_connection, sha256(convert_to(v_ticket, 'UTF8')), now() + make_interval(secs => p_seconds))
  on conflict (connection_id) do update
     set ticket_hash = excluded.ticket_hash,
         expires_at  = excluded.expires_at,
         taken_at    = now()
   where l.expires_at <= now()
  returning l.connection_id into v_got;
  return case when v_got is null then null else v_ticket end;
end $$;

/** Sends a connection's sync to the worker: 'sent', 'busy', 'not_connected' or 'not_configured'. Internal. */
create or replace function public.abo_connector_dispatch(p_connection uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_url    text;
  v_ticket text;
begin
  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds
   where ds.name = 'connector_worker_url'
   limit 1;
  if v_url is null or v_url = '' then
    return 'not_configured';
  end if;
  if not exists (select 1 from public.store_connections where id = p_connection and status = 'connected') then
    return 'not_connected';
  end if;
  v_ticket := public.abo_connector_mint(p_connection);
  if v_ticket is null then
    return 'busy';
  end if;
  perform net.http_post(
    url                  := v_url,
    body                 := jsonb_build_object('connection', p_connection, 'ticket', v_ticket),
    headers              := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  );
  return 'sent';
end $$;

/** What this ticket's worker needs: the connection, its secret, its cursors. */
create or replace function public.abo_connector_job()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', c.id, 'provider', c.provider, 'store_id', c.store_id, 'account_ref', c.account_ref,
           'secret', (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'connector:' || c.id),
           'cursors', coalesce((select jsonb_object_agg(k.resource, jsonb_build_object('cursor', k.cursor, 'synced_through', k.synced_through))
                                  from public.connector_cursors k where k.connection_id = c.id), '{}'::jsonb))
    from public.store_connections c
   where c.id = public.abo_connector_held()
$$;

/** Keeps a live ticket alive while its worker is busy: ten minutes at a time, half an hour in all. */
create or replace function public.abo_connector_renew(p_seconds integer default 360)
returns boolean
language sql volatile security definer set search_path = public as $$
  with renewed as (
    update public.connector_leases
       set expires_at = now() + make_interval(secs => least(greatest(p_seconds, 30), 600))
     where expires_at > now()
       and taken_at > now() - interval '30 minutes'
       and ticket_hash = public.abo_connector_ticket_hash()
    returning 1
  )
  select exists (select 1 from renewed)
$$;

/** Gives the ticket back. */
create or replace function public.abo_connector_release()
returns void
language sql volatile security definer set search_path = public as $$
  delete from public.connector_leases where ticket_hash = public.abo_connector_ticket_hash()
$$;

/** Hands the rest to a fresh ticket and request. Returns what dispatch said. */
create or replace function public.abo_connector_continue()
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid;
begin
  delete from public.connector_leases
   where expires_at > now()
     and ticket_hash = public.abo_connector_ticket_hash()
  returning connection_id into v_connection;
  if v_connection is null then
    return 'not_held';
  end if;
  return public.abo_connector_dispatch(v_connection);
end $$;

/** Where a resource got to. */
create or replace function public.abo_connector_put_cursor(p_resource text, p_cursor text, p_through timestamptz default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid := public.abo_connector_held();
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  insert into public.connector_cursors (connection_id, resource, cursor, synced_through, updated_at)
  values (v_connection, left(p_resource, 60), left(p_cursor, 2000), p_through, now())
  on conflict (connection_id, resource) do update
     set cursor = excluded.cursor,
         synced_through = coalesce(excluded.synced_through, public.connector_cursors.synced_through),
         updated_at = now();
end $$;

/** A renewed token, kept where the credential is. */
create or replace function public.abo_connector_put_secret(p_secret text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_connection uuid := public.abo_connector_held();
  v_vault      uuid;
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  if p_secret is null or char_length(p_secret) < 2 or char_length(p_secret) > 8000 then
    raise exception 'Not a secret.' using errcode = '22023';
  end if;
  select id into v_vault from vault.secrets where name = 'connector:' || v_connection;
  if v_vault is null then
    perform vault.create_secret(p_secret, 'connector:' || v_connection, 'Store connection credential');
  else
    perform vault.update_secret(v_vault, p_secret);
  end if;
end $$;

/**
 * The sync's end: when it last went through, when to come back, and a
 * credential the provider refused (needs_attention, until the owner
 * connects again) rather than an outage (kept connected, tried later).
 */
create or replace function public.abo_connector_done(
  p_next_minutes integer default 60,
  p_error        text    default null,
  p_refused      boolean default false
) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid := public.abo_connector_held();
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  update public.store_connections
     set last_synced_at = case when p_error is null then now() else last_synced_at end,
         last_error     = left(p_error, 500),
         status         = case when p_refused then 'needs_attention' else status end,
         next_sync_at   = now() + make_interval(mins => least(greatest(coalesce(p_next_minutes, 60), 5), 1440))
   where id = v_connection;
end $$;

/** The Shopify order a courier's reference names, in one store: its id, its number, or its number with "#". */
create or replace function public.abo_connector_order_for(p_store uuid, p_ref text)
returns uuid
language sql stable security definer set search_path = public as $$
  select o.id
    from public.orders o
   where o.store_id = p_store
     and nullif(btrim(p_ref), '') is not null
     and (o.external_id = 'gid://shopify/Order/' || btrim(p_ref)
          or o.order_number = btrim(p_ref)
          or o.order_number = '#' || ltrim(btrim(p_ref), '#'))
   order by o.placed_at desc
   limit 1
$$;

/** A page of shipments, as the adapter mapped them, written for this ticket's connection. */
create or replace function public.abo_connector_put_shipments(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_connection uuid := public.abo_connector_held();
  c            record;
  r            jsonb;
  v_n          integer := 0;
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A page is a list of at most 500.' using errcode = '22023';
  end if;
  select id, project_id, store_id, provider into c from public.store_connections where id = v_connection;
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'shipment_ref'), '') is null then continue; end if;
    insert into public.courier_shipments (
      project_id, store_id, connection_id, provider, shipment_ref, awb, order_ref, order_id,
      courier, status, status_at, ndr_reason, ndr_attempts, rto, shipped_at, delivered_at,
      freight, cod_amount, payment_mode, track_url, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'shipment_ref'), 120),
      left(nullif(btrim(r->>'awb'), ''), 120),
      left(nullif(btrim(r->>'order_ref'), ''), 120),
      public.abo_connector_order_for(c.store_id, r->>'order_ref'),
      left(nullif(btrim(r->>'courier'), ''), 120),
      left(nullif(btrim(r->>'status'), ''), 120),
      nullif(r->>'status_at', '')::timestamptz,
      left(nullif(btrim(r->>'ndr_reason'), ''), 300),
      nullif(r->>'ndr_attempts', '')::integer,
      coalesce((r->>'rto')::boolean, false),
      nullif(r->>'shipped_at', '')::timestamptz,
      nullif(r->>'delivered_at', '')::timestamptz,
      nullif(r->>'freight', '')::numeric,
      nullif(r->>'cod_amount', '')::numeric,
      left(nullif(btrim(r->>'payment_mode'), ''), 40),
      left(nullif(btrim(r->>'track_url'), ''), 500),
      now()
    )
    on conflict (connection_id, shipment_ref) do update set
      awb          = coalesce(excluded.awb, public.courier_shipments.awb),
      order_ref    = coalesce(excluded.order_ref, public.courier_shipments.order_ref),
      order_id     = coalesce(excluded.order_id, public.courier_shipments.order_id),
      courier      = coalesce(excluded.courier, public.courier_shipments.courier),
      status       = coalesce(excluded.status, public.courier_shipments.status),
      status_at    = coalesce(excluded.status_at, public.courier_shipments.status_at),
      ndr_reason   = excluded.ndr_reason,
      ndr_attempts = coalesce(excluded.ndr_attempts, public.courier_shipments.ndr_attempts),
      rto          = excluded.rto or public.courier_shipments.rto,
      shipped_at   = coalesce(excluded.shipped_at, public.courier_shipments.shipped_at),
      delivered_at = coalesce(excluded.delivered_at, public.courier_shipments.delivered_at),
      freight      = coalesce(excluded.freight, public.courier_shipments.freight),
      cod_amount   = coalesce(excluded.cod_amount, public.courier_shipments.cod_amount),
      payment_mode = coalesce(excluded.payment_mode, public.courier_shipments.payment_mode),
      track_url    = coalesce(excluded.track_url, public.courier_shipments.track_url),
      updated_at   = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ── The owner's own ──────────────────────────────────────────
/**
 * Connects a store to a provider: the credential the server just proved
 * against the provider goes into the vault, and the connection is kept.
 * The owner's alone, in Warmluke, never from their AI's token.
 */
create or replace function public.abo_connector_save(
  p_store         uuid,
  p_provider      text,
  p_account_ref   text,
  p_account_label text,
  p_secret        text,
  p_scopes        text[] default '{}'
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_id      uuid;
  v_vault   uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Connect this in Warmluke itself.' using errcode = '42501';
  end if;
  select project_id into v_project from public.stores where id = p_store and status = 'connected';
  if v_project is null or not public.abo_owns(v_project) then
    raise exception 'Only the store''s owner connects it.' using errcode = '42501';
  end if;
  if p_secret is null or char_length(p_secret) < 2 or char_length(p_secret) > 8000 then
    raise exception 'Not a credential.' using errcode = '22023';
  end if;
  insert into public.store_connections as s (
    project_id, store_id, provider, account_ref, account_label, scopes, status, last_error,
    connected_by, connected_at, disconnected_by, disconnected_at, next_sync_at
  ) values (
    v_project, p_store, p_provider, btrim(p_account_ref), nullif(btrim(p_account_label), ''), coalesce(p_scopes, '{}'),
    'connected', null, auth.uid(), now(), null, null, now()
  )
  on conflict (store_id, provider, account_ref) do update
     set account_label   = excluded.account_label,
         scopes          = excluded.scopes,
         status          = 'connected',
         last_error      = null,
         connected_by    = excluded.connected_by,
         connected_at    = now(),
         disconnected_by = null,
         disconnected_at = null,
         next_sync_at    = now()
  returning s.id into v_id;
  select id into v_vault from vault.secrets where name = 'connector:' || v_id;
  if v_vault is null then
    perform vault.create_secret(p_secret, 'connector:' || v_id, 'Store connection credential');
  else
    perform vault.update_secret(v_vault, p_secret);
  end if;
  -- Sync starts now where there is a worker; the tick picks it up otherwise.
  begin
    perform public.abo_connector_dispatch(v_id);
  exception when others then
    null;
  end;
  return v_id;
end $$;

/** Disconnects: the credential goes, the rows already brought stay. The owner's alone. */
create or replace function public.abo_connector_disconnect(p_connection uuid)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_project uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Disconnect this in Warmluke itself.' using errcode = '42501';
  end if;
  select project_id into v_project from public.store_connections where id = p_connection;
  if v_project is null or not public.abo_owns(v_project) then
    raise exception 'Only the store''s owner disconnects it.' using errcode = '42501';
  end if;
  delete from vault.secrets where name = 'connector:' || p_connection;
  delete from public.connector_leases where connection_id = p_connection;
  delete from public.connector_cursors where connection_id = p_connection;
  update public.store_connections
     set status = 'disconnected', disconnected_by = auth.uid(), disconnected_at = now(), last_error = null
   where id = p_connection;
  return true;
end $$;

/** The owner's "sync now". */
create or replace function public.abo_connector_kick(p_connection uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.store_connections c where c.id = p_connection and public.abo_owns(c.project_id)) then
    raise exception 'That connection is not yours.' using errcode = '42501';
  end if;
  update public.store_connections set next_sync_at = now() where id = p_connection;
  return public.abo_connector_dispatch(p_connection);
end $$;

-- ── The clock ────────────────────────────────────────────────
/** Every connection whose time has come and that nobody is on. */
create or replace function public.abo_connector_tick()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_connection uuid;
  v_sent       integer := 0;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'connector_worker_url') then
    return 0;
  end if;
  for v_connection in
    select c.id
      from public.store_connections c
     where c.status = 'connected'
       and c.next_sync_at <= now()
       and not exists (select 1 from public.connector_leases l where l.connection_id = c.id and l.expires_at > now())
     order by c.next_sync_at
     limit 200
  loop
    if public.abo_connector_dispatch(v_connection) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

-- ── Who may call what ────────────────────────────────────────
revoke all on function public.abo_connector_ticket_hash() from public;
revoke all on function public.abo_connector_held() from public, anon, authenticated;
revoke all on function public.abo_connector_mint(uuid, integer) from public, anon, authenticated;
revoke all on function public.abo_connector_dispatch(uuid) from public, anon, authenticated;
revoke all on function public.abo_connector_tick() from public, anon, authenticated;
revoke all on function public.abo_connector_order_for(uuid, text) from public, anon, authenticated;
-- The worker's, by its ticket.
revoke all on function public.abo_connector_job() from public, authenticated;
revoke all on function public.abo_connector_renew(integer) from public, authenticated;
revoke all on function public.abo_connector_release() from public, authenticated;
revoke all on function public.abo_connector_continue() from public, authenticated;
revoke all on function public.abo_connector_put_cursor(text, text, timestamptz) from public, authenticated;
revoke all on function public.abo_connector_put_secret(text) from public, authenticated;
revoke all on function public.abo_connector_done(integer, text, boolean) from public, authenticated;
revoke all on function public.abo_connector_put_shipments(jsonb) from public, authenticated;
grant execute on function public.abo_connector_job() to anon;
grant execute on function public.abo_connector_renew(integer) to anon;
grant execute on function public.abo_connector_release() to anon;
grant execute on function public.abo_connector_continue() to anon;
grant execute on function public.abo_connector_put_cursor(text, text, timestamptz) to anon;
grant execute on function public.abo_connector_put_secret(text) to anon;
grant execute on function public.abo_connector_done(integer, text, boolean) to anon;
grant execute on function public.abo_connector_put_shipments(jsonb) to anon;
-- The owner's.
revoke all on function public.abo_connector_save(uuid, text, text, text, text, text[]) from public, anon;
revoke all on function public.abo_connector_disconnect(uuid) from public, anon;
revoke all on function public.abo_connector_kick(uuid) from public, anon;
grant execute on function public.abo_connector_save(uuid, text, text, text, text, text[]) to authenticated;
grant execute on function public.abo_connector_disconnect(uuid) to authenticated;
grant execute on function public.abo_connector_kick(uuid) to authenticated;

-- ── The list ─────────────────────────────────────────────────
create or replace view public.store_courier_shipments with (security_invoker = true) as
select cs.id,
       cs.store_id,
       cs.provider,
       cs.awb,
       coalesce(o.order_number, cs.order_ref) as order_number,
       cs.courier,
       cs.status,
       to_char((cs.status_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as status_on,
       cs.ndr_reason,
       cs.ndr_attempts,
       cs.rto,
       to_char((cs.shipped_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as shipped_at,
       to_char((cs.delivered_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as delivered_at,
       cs.freight,
       cs.cod_amount,
       cs.payment_mode,
       cs.track_url,
       o.external_id as shopify_order_id,
       cs.updated_at
  from public.courier_shipments cs
  left join public.orders o on o.id = cs.order_id
  left join public.stores st on st.id = cs.store_id;
grant select on public.store_courier_shipments to authenticated;

-- 0106's mapping, one line longer.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'            then 'store_orders'
    when 'customers'         then 'store_customers'
    when 'products'          then 'store_products'
    when 'inventory_levels'  then 'store_inventory'
    when 'product_sales'     then 'product_sales'
    when 'order_line_items'  then 'store_order_items'
    when 'refunds'           then 'store_refunds'
    when 'variants'          then 'store_variants'
    when 'fulfillments'      then 'store_fulfillments'
    when 'transactions'      then 'store_transactions'
    when 'locations'         then 'store_locations'
    when 'collections'       then 'store_collections'
    when 'carts'             then 'store_abandoned_checkouts'
    when 'drafts'            then 'store_draft_orders'
    when 'draft_order_items' then 'store_draft_order_items'
    when 'discounts'         then 'store_discounts'
    when 'returns'           then 'store_returns'
    when 'return_reasons'    then 'return_reasons'
    when 'payouts'           then 'store_payouts'
    when 'courier_shipments' then 'store_courier_shipments'
  end;
$$;

-- Where pg_cron is installed (production); the check project has none.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-connector-tick', '*/5 * * * *', 'select public.abo_connector_tick()');
  end if;
end $$;

notify pgrst, 'reload schema';
