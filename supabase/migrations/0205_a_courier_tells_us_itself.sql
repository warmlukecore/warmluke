-- Migration 0205: a courier tells us itself
--
-- Connectors, phase 3 (docs/integrations/connectors.md, 11 Oct). GoSwift
-- has no list of shipments to walk: it posts each one, as it is made and
-- as it moves, to an address we register with it. This is that address's
-- half in the database, written for any provider that pushes.
--
-- - store_connections.hook_hash   the hash of the token in a connection's
--                                 hook address. The token is in the
--                                 connection's vault credential, never a
--                                 column; its hash cannot be posted to.
-- - abo_connector_put_hook        the sync, by its ticket, keeps a new
--                                 token's hash when it registers the address.
-- - abo_connector_hook            a delivery: the address's token names the
--                                 connection, which must still be connected,
--                                 and its rows go to that connection alone.
-- - abo_connector_open_shipments  the sync, by its ticket, asks which of its
--                                 shipments have gone quiet, to ask after them.
-- - abo_connector_write_shipments the one writer both roads share: 0204's,
--                                 except a row that says no status leaves
--                                 the NDR reason as it was.
--
-- Disconnecting forgets the address too: its deliveries are refused from then.

alter table public.store_connections add column if not exists hook_hash bytea;
create unique index if not exists store_connections_hook
  on public.store_connections (hook_hash) where hook_hash is not null;

-- ── The writer both roads share ──────────────────────────────
create or replace function public.abo_connector_write_shipments(p_connection uuid, p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   record;
  r   jsonb;
  v_n integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A page is a list of at most 500.' using errcode = '22023';
  end if;
  select id, project_id, store_id, provider into c from public.store_connections where id = p_connection;
  if c.id is null then
    return 0;
  end if;
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
      -- A new status clears an old NDR; a row that says none leaves it.
      ndr_reason   = case when excluded.status is null then public.courier_shipments.ndr_reason else excluded.ndr_reason end,
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

/** A page of shipments, as the adapter mapped them, written for this ticket's connection. */
create or replace function public.abo_connector_put_shipments(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid := public.abo_connector_held();
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  return public.abo_connector_write_shipments(v_connection, p_rows);
end $$;

-- ── The address ──────────────────────────────────────────────
/** The token in this ticket's connection's hook address, kept as its hash. */
create or replace function public.abo_connector_put_hook(p_token text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid := public.abo_connector_held();
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'Not a hook token.' using errcode = '22023';
  end if;
  update public.store_connections
     set hook_hash = sha256(convert_to(p_token, 'UTF8'))
   where id = v_connection;
end $$;

/**
 * A provider's delivery: the token in the address it was posted to names
 * one connection, of that provider, still connected; its rows go there.
 */
create or replace function public.abo_connector_hook(p_provider text, p_token text, p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare v_connection uuid;
begin
  select c.id into v_connection
    from public.store_connections c
   where p_token is not null
     and char_length(p_token) between 32 and 128
     and c.hook_hash = sha256(convert_to(p_token, 'UTF8'))
     and c.provider = p_provider
     and c.status = 'connected';
  if v_connection is null then
    raise exception 'Not a hook we know.' using errcode = '42501';
  end if;
  return public.abo_connector_write_shipments(v_connection, p_rows);
end $$;

/** This ticket's shipments not settled, quiet for six hours, oldest first: the ones to ask after. */
create or replace function public.abo_connector_open_shipments(p_settled text[], p_limit integer default 100)
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(q.shipment_ref order by q.updated_at), '{}')
    from (
      select s.shipment_ref, s.updated_at
        from public.courier_shipments s
       where s.connection_id = public.abo_connector_held()
         and s.delivered_at is null
         and (s.status is null or not (s.status = any (coalesce(p_settled, '{}'))))
         and s.updated_at < now() - interval '6 hours'
       order by s.updated_at
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) q
$$;

-- 0204's, forgetting the address as well.
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
     set status = 'disconnected', disconnected_by = auth.uid(), disconnected_at = now(), last_error = null,
         hook_hash = null
   where id = p_connection;
  return true;
end $$;

-- ── Who may call what ────────────────────────────────────────
revoke all on function public.abo_connector_write_shipments(uuid, jsonb) from public, anon, authenticated;
-- The worker's, by its ticket.
revoke all on function public.abo_connector_put_hook(text) from public, authenticated;
revoke all on function public.abo_connector_open_shipments(text[], integer) from public, authenticated;
grant execute on function public.abo_connector_put_hook(text) to anon;
grant execute on function public.abo_connector_open_shipments(text[], integer) to anon;
-- The provider's, by the address's token.
revoke all on function public.abo_connector_hook(text, text, jsonb) from public, authenticated;
grant execute on function public.abo_connector_hook(text, text, jsonb) to anon;

notify pgrst, 'reload schema';
