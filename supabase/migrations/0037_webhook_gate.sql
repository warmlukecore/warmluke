-- Migration 0037: the database checks the signature itself.
--
-- Every webhook write function was executable by `anon`, and the anon
-- key is public — it ships in the browser bundle. The signature check
-- lived in the Next.js route, which an attacker simply does not use:
-- PostgREST is right there. So anyone at all could inject orders into
-- any shop, rewrite its catalogue, or call abo_shopify_shop_redact and
-- erase a merchant's imported data.
--
-- This was true before today; the catalogue functions in 0036 only
-- made the same door wider.
--
-- The fix is not a better route. It is that the writes stop being
-- reachable from outside at all: one gatekeeper is granted, it
-- verifies Shopify's HMAC against a secret the database holds, and it
-- calls the others internally. Without a signature this app's secret
-- could have produced, nothing happens, whatever key the caller has.
--
-- Callers: src/app/api/shopify/webhooks/route.ts.

-- Secrets the database needs for itself. No policies, so no role
-- reaches it through PostgREST — only the definer function below,
-- which runs as the owner.
create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on table public.app_secrets from anon, authenticated;

-- The one thing a webhook caller may do.
--
-- Verifies the signature over the exact bytes Shopify sent, then does
-- the write. The shop comes from the header the caller passes, which
-- is how Shopify's own scheme works — the signature is what decides
-- whether anything happens at all.
create or replace function public.abo_shopify_webhook(
  p_topic text,
  p_shop  text,
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
  if p_raw is null or p_hmac is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;
  -- The compliance topics name the shop in the body; the rest rely on
  -- the header, which the route passes through.
  v_shop := coalesce(nullif(p_shop, ''), v_body->>'shop_domain');

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

  -- Signed, so it really is Shopify — just a topic nobody asked for.
  return 0;
end $$;

-- The writes themselves stop being reachable from outside.
revoke execute on function public.abo_shopify_upsert_order(text, jsonb) from anon, authenticated;
revoke execute on function public.abo_shopify_upsert_product(text, jsonb) from anon, authenticated;
revoke execute on function public.abo_shopify_delete_product(text, text) from anon, authenticated;
revoke execute on function public.abo_shopify_upsert_customer(text, jsonb) from anon, authenticated;
revoke execute on function public.abo_shopify_delete_customer(text, text) from anon, authenticated;
revoke execute on function public.abo_shopify_set_inventory(text, jsonb) from anon, authenticated;
revoke execute on function public.abo_shopify_data_request(text, text, jsonb) from anon, authenticated;
revoke execute on function public.abo_shopify_customer_redact(text, text) from anon, authenticated;
revoke execute on function public.abo_shopify_shop_redact(text) from anon, authenticated;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
