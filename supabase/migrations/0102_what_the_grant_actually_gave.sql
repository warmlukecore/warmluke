-- Migration 0102: what the grant actually gave.
--
-- The install asks Shopify for a list of scopes. Shopify decides what
-- it hands over, and the answer comes back in the grant itself — in
-- the `scope` field of the token response, which this app has read and
-- thrown away since the first connect.
--
-- So "does this store's token allow returns?" had no answer here. The
-- only way to find out was to make a call and read the refusal, which
-- is how a reconnect that never happened can be believed for an hour:
-- the row says connected, the token works, and nothing anywhere says
-- it is a token from before the scopes were added.
--
-- Null is not empty. A store connected before this column existed has
-- an unknown grant, not an empty one, and anything reading this has to
-- tell those apart — treating null as "nothing granted" would stop an
-- import that works perfectly well.
--
-- Callers: src/app/api/shopify/callback/route.ts (on connect),
-- src/lib/shopify-import.ts (ensureFreshToken, which backfills a store
-- connected before today at its next renewal), and missingScopes in
-- src/lib/shopify-resources.ts.

alter table public.stores
  add column if not exists granted_scopes text[];

comment on column public.stores.granted_scopes is
  'The scopes Shopify actually granted this token, as the grant reported them. Null means a store connected before this was recorded: unknown, not empty.';

-- 0046 revoked the table-wide select and granted the safe columns by
-- name, and said in its own comment that a column added afterwards
-- would be unreadable until it was named here. This is that column.
-- It is not a secret — it is a list of scope names, no different from
-- the ones the install URL carries in the clear — and the screen that
-- has to say "these need a reconnect" reads it as the owner.
grant select (granted_scopes) on public.stores to authenticated;

-- The old signature is dropped rather than left beside the new one:
-- two overloads differing by one argument is how a caller ends up
-- silently using the one that records nothing (0054 said the same
-- about the one that checked nothing).
drop function if exists public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer);

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
  -- Defaulted, and only for the minutes between this migration and
  -- the deployment that starts sending it. A merchant coming back
  -- from Shopify in that window must not meet "no such function" —
  -- their code is already spent and there is nothing to retry. The
  -- callback always sends it; check-shopify holds that.
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
         -- What this particular grant came with. Replaced outright
         -- when there is one, never merged: a reconnect that granted
         -- LESS than the last one is exactly the case this column
         -- exists to show, and merging would hide it behind the
         -- older, wider list. Kept only when the caller said nothing
         -- at all, which is the deploy window above — not being told
         -- is not the same as being told "nothing".
         granted_scopes           = coalesce(p_scopes, stores.granted_scopes),
         status                   = 'connected',
         connected_at             = now(),
         -- Spent. A captured callback replayed later finds nothing.
         oauth_state              = null,
         oauth_state_expires_at   = null
   where oauth_state = p_state
     and oauth_state_expires_at > now()
     -- The nonce says which attempt this is; the shop says which store
     -- came back. Both have to agree, or a token lands on a row naming
     -- somebody else's shop.
     and lower(shop_domain) = lower(p_shop)
   returning project_id into v_project;

  return v_project;  -- null: unknown, used, expired, or a different shop
end $$;

revoke all on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer, text[]) from public;
grant execute on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer, text[]) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
