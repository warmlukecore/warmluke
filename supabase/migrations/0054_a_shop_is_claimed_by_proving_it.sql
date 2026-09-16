-- Migration 0054: the three things a second merchant would hit.
--
-- All of this works for the one store connected today and breaks the
-- moment somebody else brings their own.
--
-- 1. A domain was claimed before anyone proved they owned it. The
--    install route writes a pending row and only then sends the
--    merchant to Shopify, and (provider, shop_domain) was unique
--    across every status — so any signed-in stranger could type
--    somebody else's myshopify.com address and hold it for ever. The
--    real merchant would meet a duplicate key with no way round it.
--    Pending rows now sit outside the constraint: several people may
--    be mid-install for one domain, and the first to come back from
--    Shopify with a token gets it.
--
-- 2. The nonce was not tied to the shop. abo_shopify_connect found its
--    row by oauth_state alone and never checked that the shop Shopify
--    handed back was the shop that row claimed — so a callback for one
--    store could write its token onto a row wearing another store's
--    name. The shop now has to match.
--
-- 3. Subscribing the webhooks is allowed to fail, and deliberately is
--    not fatal: the store is connected and the importer works without
--    it. But nothing recorded the failure, so the merchant was told
--    "connected" about a store that would never tell us anything
--    again. It is written down now and the app can say so.
--
-- Callers: src/app/api/shopify/callback/route.ts,
-- src/app/api/shopify/install/route.ts, src/components/StoreStrip.tsx.

alter table public.stores
  add column if not exists webhook_error text;

comment on column public.stores.webhook_error is
  'Why Shopify was not asked to send updates. Set at connect, cleared when it works.';

-- Pending is an attempt, not a claim.
drop index if exists public.idx_stores_shop;
create unique index if not exists idx_stores_shop
  on public.stores(provider, shop_domain)
  where status <> 'pending';

-- The old signature is dropped rather than left beside the new one:
-- two overloads differing by one argument is how a caller ends up
-- silently using the one that checks nothing.
drop function if exists public.abo_shopify_connect(text, text, text, text, text, text, integer, integer);

create or replace function public.abo_shopify_connect(
  p_state              text,
  p_shop               text,
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
     -- The nonce says which attempt this is; the shop says which store
     -- came back. Both have to agree, or a token lands on a row naming
     -- somebody else's shop.
     and lower(shop_domain) = lower(p_shop)
   returning project_id into v_project;

  return v_project;  -- null: unknown, used, expired, or a different shop
end $$;

revoke all on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer) from public;
grant execute on function public.abo_shopify_connect(text, text, text, text, text, text, text, integer, integer) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
