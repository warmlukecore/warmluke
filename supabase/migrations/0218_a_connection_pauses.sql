-- Migration 0218: a connection pauses, and resumes (docs/integrations/connectors.md)
--
-- An owner could connect an account or disconnect it, and disconnecting
-- dropped its credential: to stop the syncing for a while they had to
-- type the login in again afterwards. Paused keeps the credential and
-- every row already brought, and brings nothing new until resumed.
--
-- Nothing else needs to learn the word. Everything that moves data asks
-- for status = 'connected' already: the tick and its index, a ticket's
-- minting and every write a ticket makes (abo_connector_held), Sync now
-- (abo_connector_dispatch says not_connected), and a provider's own
-- delivery (abo_connector_hook). Pausing also drops the live ticket, so
-- a sync on its way stops at its next write and a resume can start one
-- at once.

alter table public.store_connections drop constraint if exists store_connections_status_check;
alter table public.store_connections
  add constraint store_connections_status_check
  check (status in ('connected', 'needs_attention', 'paused', 'disconnected'));

/** Pauses a connected account, or resumes a paused one and syncs it now. The owner's alone, in Warmluke. */
create or replace function public.abo_connector_pause(p_connection uuid, p_paused boolean)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_status  text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Pause or resume this in Warmluke itself.' using errcode = '42501';
  end if;
  select project_id, status into v_project, v_status from public.store_connections where id = p_connection;
  if v_project is null or not public.abo_owns(v_project) then
    raise exception 'Only the store''s owner pauses or resumes it.' using errcode = '42501';
  end if;
  if p_paused then
    if v_status <> 'connected' then
      raise exception 'Only a connected account can be paused.' using errcode = '22023';
    end if;
    update public.store_connections set status = 'paused' where id = p_connection;
    delete from public.connector_leases where connection_id = p_connection;
    return 'paused';
  end if;
  if v_status <> 'paused' then
    raise exception 'It is not paused.' using errcode = '22023';
  end if;
  update public.store_connections set status = 'connected', next_sync_at = now() where id = p_connection;
  -- Sync starts now where there is a worker; the tick picks it up otherwise.
  begin
    perform public.abo_connector_dispatch(p_connection);
  exception when others then
    null;
  end;
  return 'connected';
end $$;

revoke all on function public.abo_connector_pause(uuid, boolean) from public, anon;
grant execute on function public.abo_connector_pause(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
