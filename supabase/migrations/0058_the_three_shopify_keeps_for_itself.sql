-- Migration 0058: the three topics 0057 left with nowhere to arrive.
--
-- 0057 gave every store its own webhook address and deleted the static
-- one. That is right for the ordinary topics, which we subscribe per
-- store and can therefore point wherever we like. It is wrong for the
-- three compliance topics: Shopify does not let an app subscribe to
-- customers/data_request, customers/redact or shop/redact at all. They
-- are configured once, in the app's own settings, as a single URI for
-- every shop — so after 0057 they had no handler to reach, and
-- shop/redact is the one that erases a merchant's data.
--
-- They cannot use a per-store address because there is no per-store
-- URL to give Shopify. So they take the one binding that is actually
-- available: these payloads carry shop_domain INSIDE the signed body.
-- The body is what Shopify's HMAC covers, so a shop read from there is
-- as trustworthy as the signature itself — which is exactly what the
-- header was not, and why 0057 stopped believing it.
--
-- And abo_shopify_webhook_token was marked immutable while reading
-- app_secrets. A cached plan could hold an address computed from a
-- secret that has since been rotated.
--
-- Callers: src/app/api/shopify/webhooks/compliance/route.ts,
-- src/app/api/shopify/webhooks/[token]/route.ts.

-- Reads a table, so it can be stable and no more than that.
create or replace function public.abo_shopify_webhook_token(p_shop text)
returns text
language sql stable security definer set search_path = public, extensions as $$
  select encode(
           extensions.hmac(lower(p_shop),
                           (select value from public.app_secrets
                             where name = 'shopify_client_secret'),
                           'sha256'),
           'hex')
$$;

revoke all on function public.abo_shopify_webhook_token(text) from public;

-- The three, and only the three.
create or replace function public.abo_shopify_compliance(
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
  if p_raw is null or p_hmac is null or p_topic is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;
  -- From the signed body, never a header. Naming another merchant's
  -- shop here would mean forging a body, which means holding the app
  -- secret.
  v_shop := v_body->>'shop_domain';
  if v_shop is null or v_shop = '' then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  -- This door opens for nothing else. Every ordinary topic has a
  -- per-store address and must come through that, or the app-wide URI
  -- would be a way round it.
  if p_topic = 'customers/data_request' then
    -- abo_shopify_data_request is the one handler that returns
    -- boolean; every other returns integer. Returning it straight out of a
    -- returns-integer function raises 22P02 at run time, so a real
    -- data request has never once been recorded — Shopify got a 500
    -- and retried for two days. The dispatch has carried this since it
    -- was written; it only showed up when something finally called it.
    return case when public.abo_shopify_data_request(
                       v_shop, v_body#>>'{customer,id}', v_body) then 1 else 0 end;
  elsif p_topic = 'customers/redact' then
    return public.abo_shopify_customer_redact(v_shop, v_body#>>'{customer,id}');
  elsif p_topic = 'shop/redact' then
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  raise exception 'Unsigned.' using errcode = '42501';
end $$;

revoke all on function public.abo_shopify_compliance(text, text, text) from public;
grant execute on function public.abo_shopify_compliance(text, text, text) to anon, authenticated;

-- And the tokenized door stops claiming to handle them. Leaving the
-- branches in would say these arrive per store, which they never do.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

-- Any bulk file still part-read was produced before groupObjects was
-- asked for, so its lines are in no order the reader can trust. The
-- resource starts again rather than finishing a file it will
-- misinterpret.
update public.import_runs
   set status = 'pending', cursor = null, finished_at = null, imported = 0
 where cursor like 'bulk:%' or cursor like 'read:%';

NOTIFY pgrst, 'reload schema';
