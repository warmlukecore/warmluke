-- Migration 0062: three ways 0061 was still only half a check.
--
-- 1. An email-only redaction did nothing, and said it had.
--
--    Shopify documents that a customer in these payloads may carry
--    only an email — somebody who ordered without ever making an
--    account. 0061 was right to stop demanding an id. But it then
--    passed a null customer to abo_shopify_customer_redact, which
--    matches external_id against a key built from null, deletes
--    nothing, and returns 0. The route answered 200.
--
--    So the worst kind of wrong: a legal obligation reported as
--    honoured and never carried out. A redaction now falls back to the
--    email, and reports only what it really deleted.
--
-- 2. The two customer topics were not mutually exclusive. A body
--    carrying BOTH orders_requested and orders_to_redact satisfied
--    either branch, so the pair that was supposed to tell them apart
--    did so only while the body was well behaved.
--
-- 3. `v_body ? 'customer'` asks whether the KEY is there, not whether
--    there is a customer. "customer": null passed it, and so did
--    "customer": "banana".
--
-- Callers: src/app/api/shopify/webhooks/compliance/route.ts.

-- Redaction by email, for the customer who never had an account.
create or replace function public.abo_shopify_customer_redact_email(
  p_shop  text,
  p_email text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_deleted integer;
begin
  if p_email is null or btrim(p_email) = '' then return 0; end if;

  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  delete from public.customers
   where store_id = v_store
     and lower(email) = lower(btrim(p_email));

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_customer_redact_email(text, text) from public;

create or replace function public.abo_shopify_compliance(
  p_topic text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret   text;
  v_body     jsonb;
  v_shop     text;
  v_customer text;
  v_email    text;
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

  v_body     := p_raw::jsonb;
  v_shop     := v_body->>'shop_domain';
  v_customer := v_body#>>'{customer,id}';
  v_email    := v_body#>>'{customer,email}';

  if v_shop is null or v_shop = '' then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  if p_topic = 'customers/data_request' then
    -- A customer, and this topic's list and not the other one.
    if jsonb_typeof(v_body->'customer') is distinct from 'object'
       or not (v_body ? 'orders_requested')
       or v_body ? 'orders_to_redact' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return case when public.abo_shopify_data_request(v_shop, v_customer, v_body) then 1 else 0 end;

  elsif p_topic = 'customers/redact' then
    if jsonb_typeof(v_body->'customer') is distinct from 'object'
       or not (v_body ? 'orders_to_redact')
       or v_body ? 'orders_requested' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    -- By id where there is one, by email where there is not. A
    -- customer without an account still has the right to be forgotten.
    if v_customer is not null then
      return public.abo_shopify_customer_redact(v_shop, v_customer);
    end if;
    if v_email is not null and btrim(v_email) <> '' then
      return public.abo_shopify_customer_redact_email(v_shop, v_email);
    end if;
    -- Neither. Refusing beats answering 200 to a request nothing can
    -- act on: Shopify retries, and somebody sees it.
    raise exception 'Unsigned.' using errcode = '42501';

  elsif p_topic = 'shop/redact' then
    if v_body ? 'customer'
       or v_body ? 'orders_requested'
       or v_body ? 'orders_to_redact' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  raise exception 'Unsigned.' using errcode = '42501';
end $$;

revoke all on function public.abo_shopify_compliance(text, text, text) from public;
grant execute on function public.abo_shopify_compliance(text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
