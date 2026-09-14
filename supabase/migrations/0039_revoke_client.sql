-- Migration 0039: take an assistant's access away.
--
-- A merchant could connect Claude and never disconnect it. The
-- consent screen was a one-way door: the refresh token lasts ninety
-- days, so a laptop left behind, a shared machine, or simply changing
-- your mind meant ninety days of access nobody could stop.
--
-- Revoking is two things, and doing only the first is the mistake
-- worth naming: marking the consent revoked stops the client asking
-- for a NEW token, and does nothing at all about the one it already
-- has. The sessions have to go too.
--
-- The auth schema is not reachable through PostgREST, so both live
-- here as definer functions scoped to the caller's own rows.
--
-- Callers: src/components/ChatPanel.tsx.

-- Which assistants this account has connected, and what they have
-- been doing. The last call comes from mcp_calls, so "connected" and
-- "actually in use" are not confused with each other.
create or replace function public.abo_oauth_clients()
returns table (
  client_id  uuid,
  name       text,
  granted_at timestamptz,
  sessions   bigint,
  last_call  timestamptz,
  calls_24h  bigint
)
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    return;
  end if;

  return query
    select
      c.client_id,
      coalesce(cl.client_name, 'An assistant')::text,
      c.granted_at,
      (select count(*) from auth.sessions s
        where s.user_id = auth.uid() and s.oauth_client_id = c.client_id),
      (select max(m.created_at) from public.mcp_calls m
        where m.user_id = auth.uid() and m.client_id = c.client_id::text),
      (select count(*) from public.mcp_calls m
        where m.user_id = auth.uid() and m.client_id = c.client_id::text
          and m.created_at > now() - interval '24 hours')
    from auth.oauth_consents c
    left join auth.oauth_clients cl on cl.id = c.client_id
   where c.user_id = auth.uid()
     and c.revoked_at is null
   order by c.granted_at desc;
end $$;

-- Ends it, now.
--
-- Returns how many sessions were closed, because that is the number
-- that says whether anything was really taken away.
create or replace function public.abo_oauth_revoke(p_client uuid)
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_sessions integer; v_consents integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  -- Scoped to the caller's own rows: a client id is not a secret, and
  -- one merchant must not be able to disconnect another's assistant.
  update auth.oauth_consents
     set revoked_at = now()
   where user_id = auth.uid() and client_id = p_client and revoked_at is null;
  get diagnostics v_consents = row_count;

  -- The part that matters. Without this the client keeps the token it
  -- already holds for the rest of its ninety days.
  delete from auth.sessions
   where user_id = auth.uid() and oauth_client_id = p_client;
  get diagnostics v_sessions = row_count;

  return jsonb_build_object('consents', v_consents, 'sessions', v_sessions);
end $$;

revoke all on function public.abo_oauth_clients() from public;
revoke all on function public.abo_oauth_revoke(uuid) from public;
grant execute on function public.abo_oauth_clients() to authenticated;
grant execute on function public.abo_oauth_revoke(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
