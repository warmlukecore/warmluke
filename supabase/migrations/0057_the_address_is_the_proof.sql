-- Migration 0057: the second signature was minted by the thing it
-- was supposed to be checking.
--
-- 0055 made the database demand a signature over topic, shop and body
-- so that a captured delivery could not be re-aimed at somebody else's
-- store. But the route produced that signature from the very headers
-- an attacker controls: it verified Shopify's HMAC over the body
-- alone, then read x-shopify-topic and x-shopify-shop-domain and
-- signed whatever they said. Replaying one real signed body through
-- the route with a different shop header therefore got a perfectly
-- valid p_sig back. The check was real; the oracle standing next to it
-- handed out the answers.
--
-- The mistake was trying to authenticate a claim the caller makes.
-- Shopify's HMAC uses one secret for the whole app, so it proves the
-- body came from Shopify and can never prove which shop it came from.
--
-- So the shop stops being something the request says and becomes
-- something the request cannot choose: which address it arrived at.
-- Every store gets its own webhook URL, and the last segment is
-- hmac(shop_domain, app secret) — unguessable without the secret we
-- already hold, derived rather than stored, so there is no new column
-- to back-fill and no new secret for a client to read. The shop is
-- looked up FROM that segment here; p_shop is gone.
--
-- A merchant can still see their own address in their own Shopify
-- admin, so they can still post their own signed body to their own
-- store with a topic of their choosing. That is the remaining reach
-- and it ends at their own data.
--
-- Callers: src/app/api/shopify/webhooks/[token]/route.ts,
-- src/app/api/shopify/callback/route.ts, scripts/subscribe-webhooks.mjs.

-- One shop, one row, whatever case it is written in.
--
-- The address below is hmac(lower(shop_domain)), so two rows differing
-- only by case would hash to the same address and the lookup would
-- take whichever one Postgres handed back first. 0054's index was
-- case-sensitive and would have allowed exactly that pair. Everything
-- connecting today is lowercased on the way in, so this changes
-- nothing now and removes the ambiguity by construction.
drop index if exists public.idx_stores_shop;
create unique index if not exists idx_stores_shop
  on public.stores(provider, lower(shop_domain))
  where status <> 'pending';

drop function if exists public.abo_shopify_webhook(text, text, text, text, text);
drop function if exists public.abo_shopify_webhook(text, text, text, text);

-- The address a store's webhooks must arrive at.
create or replace function public.abo_shopify_webhook_token(p_shop text)
returns text
language sql immutable security definer set search_path = public, extensions as $$
  select encode(
           extensions.hmac(lower(p_shop),
                           (select value from public.app_secrets
                             where name = 'shopify_client_secret'),
                           'sha256'),
           'hex')
$$;

revoke all on function public.abo_shopify_webhook_token(text) from public;

create or replace function public.abo_shopify_webhook(
  p_token text,
  p_topic text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_body   jsonb;
  v_shop   text;
begin
  select value into v_secret from public.app_secrets where name = 'shopify_client_secret';
  if v_secret is null then
    raise exception 'Webhooks are not configured.' using errcode = '42501';
  end if;
  if p_raw is null or p_hmac is null or p_token is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  -- Which store, decided here and never by the caller. An address
  -- nobody recognises is refused rather than treated as a shop we have
  -- not met: there is no legitimate delivery to an unknown address.
  select s.shop_domain into v_shop
    from public.stores s
   where s.provider = 'shopify'
     and s.status <> 'pending'
     and encode(extensions.hmac(lower(s.shop_domain), v_secret, 'sha256'), 'hex') = p_token;

  if v_shop is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;

  if p_topic in ('orders/create', 'orders/updated', 'orders/cancelled',
                 'orders/paid', 'orders/fulfilled') then
    return public.abo_shopify_upsert_order(v_shop, v_body);
  elsif p_topic in ('products/create', 'products/update') then
    return public.abo_shopify_upsert_product(v_shop, v_body);
  elsif p_topic = 'products/delete' then
    return public.abo_shopify_delete_product(v_shop, v_body->>'id');
  elsif p_topic in ('customers/create', 'customers/update') then
    return public.abo_shopify_upsert_customer(v_shop, v_body);
  elsif p_topic = 'customers/delete' then
    return public.abo_shopify_delete_customer(v_shop, v_body->>'id');
  elsif p_topic in ('inventory_levels/update', 'inventory_levels/connect') then
    return public.abo_shopify_set_inventory(v_shop, v_body);
  elsif p_topic = 'customers/data_request' then
    return public.abo_shopify_data_request(v_shop, v_body#>>'{customer,id}', v_body);
  elsif p_topic = 'customers/redact' then
    return public.abo_shopify_customer_redact(v_shop, v_body#>>'{customer,id}');
  elsif p_topic = 'shop/redact' then
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  -- Signed, and at a real address — just a topic nobody asked for.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
