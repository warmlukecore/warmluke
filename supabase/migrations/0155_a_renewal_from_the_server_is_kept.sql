-- Migration 0155: a renewal from the server is kept
--
-- A Shopify token lasts an hour, and renewing it spends the refresh
-- token it was renewed with. 0110 kept a renewal only for the store's
-- owner or the worker holding its ticket. A script with the service
-- key (scripts/tools/shopify-query-cost.mjs is one) renewed a store's
-- token, was told "not allowed" when it tried to keep the new one, and
-- so left the store with a refresh token Shopify had already retired:
-- the next renewal failed, and the merchant had to connect again.
--
-- The service key can already write this row directly; letting it keep
-- a renewal through the one function that does it adds no reach, and
-- means a renewal is never lost to who asked for it.

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
       or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     )
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.abo_store_renewed(uuid, text, text, timestamptz, timestamptz, text[]) from public;
grant execute on function public.abo_store_renewed(uuid, text, text, timestamptz, timestamptz, text[])
  to anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
