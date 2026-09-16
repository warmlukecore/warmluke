-- Migration 0061: two topics that could still wear each other's body.
--
-- 0059 stopped a customer payload being replayed as shop/redact, which
-- was the one that deleted a store. But it told the two customer
-- topics apart by nothing at all: both required a customer and neither
-- required anything else, so a signed customers/data_request could
-- still be posted back as customers/redact — and that one erases a
-- customer's rows rather than recording a request.
--
-- Shopify sends a different list with each:
--
--   customers/data_request  carries orders_requested
--   customers/redact        carries orders_to_redact
--
-- Both are inside the signed body, so requiring the right one binds
-- the verb to what was actually signed. That is the whole idea from
-- 0057 onwards: never believe the unsigned header when the signed body
-- can answer instead.
--
-- And 0059 asked for customer.id, which drops real requests. Shopify
-- documents that a customer record in these payloads may carry only an
-- email — a customer who never had an account still has a right to
-- ask. The customer object has to be there; its id does not.
--
-- Callers: src/app/api/shopify/webhooks/compliance/route.ts.

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
  -- May be null: a customer who never had an account is named by email
  -- alone, and still has the right to ask.
  v_customer := v_body#>>'{customer,id}';

  if v_shop is null or v_shop = '' then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  if p_topic = 'customers/data_request' then
    -- The list is what separates this from a redaction.
    if not (v_body ? 'customer') or not (v_body ? 'orders_requested') then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return case when public.abo_shopify_data_request(v_shop, v_customer, v_body) then 1 else 0 end;

  elsif p_topic = 'customers/redact' then
    if not (v_body ? 'customer') or not (v_body ? 'orders_to_redact') then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_customer_redact(v_shop, v_customer);

  elsif p_topic = 'shop/redact' then
    -- The destructive one stays the strictest: a shop/redact body names
    -- no customer and carries neither list.
    if v_body ? 'customer' or v_body ? 'orders_requested' or v_body ? 'orders_to_redact' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  raise exception 'Unsigned.' using errcode = '42501';
end $$;

revoke all on function public.abo_shopify_compliance(text, text, text) from public;
grant execute on function public.abo_shopify_compliance(text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
