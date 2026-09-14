-- Migration 0024: Shopify access tokens now expire.
--
-- Shopify stopped accepting non-expiring tokens on the Admin API. Every
-- call made with one answers:
--
--   403 [API] Non-expiring access tokens are no longer accepted
--
-- An expiring token lasts an hour and arrives with a refresh token good
-- for ninety days, which renews it server-side without the merchant
-- being asked again. So the store row has to hold three more things: the
-- refresh token, when the access token dies, and when the refresh token
-- itself dies.
--
-- All three are nullable because a store connected before this change
-- has none of them. Such a store cannot be renewed and has to be
-- reconnected — the import says so rather than retrying forever.

alter table public.stores
  add column if not exists refresh_token            text,
  add column if not exists token_expires_at         timestamptz,
  add column if not exists refresh_token_expires_at timestamptz;

-- The connect function grew three arguments, so the old one is dropped
-- rather than left beside it: two overloads differing only in arity is
-- how a caller ends up silently using the one that stores no expiry.
drop function if exists public.abo_shopify_connect(text, text, text, text, text);

create or replace function public.abo_shopify_connect(
  p_state              text,
  p_token              text,
  p_timezone           text,
  p_currency           text,
  p_country            text,
  p_refresh_token      text,
  p_expires_in         integer,
  p_refresh_expires_in integer
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
         status                   = 'connected',
         connected_at             = now(),
         -- Spent. A captured callback replayed later finds nothing.
         oauth_state              = null,
         oauth_state_expires_at   = null
   where oauth_state = p_state
     and oauth_state_expires_at > now()
   returning project_id into v_project;

  return v_project;  -- null: unknown, already used, or expired
end $$;

revoke all on function public.abo_shopify_connect(text, text, text, text, text, text, integer, integer) from public;
grant execute on function public.abo_shopify_connect(text, text, text, text, text, text, integer, integer) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
