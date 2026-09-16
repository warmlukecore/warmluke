-- Migration 0059: the compliance door read the topic off a header too.
--
-- 0058 gave the three compliance topics their own door and was careful
-- about the shop: it reads shop_domain from the SIGNED body, because
-- Shopify's HMAC covers the body and nothing else. Then it dispatched
-- on p_topic — which comes from x-shopify-topic, a header that same
-- HMAC does not cover.
--
-- So the shop was safe and the verb was not. A merchant holding one of
-- their own signed customers/data_request deliveries could post it
-- back naming shop/redact, and abo_shopify_shop_redact would delete
-- their store and everything cascading from it. A real request, read
-- as a different sentence.
--
-- The fix is the same idea as the shop: stop believing the unsigned
-- part, and make the signed part prove it. Shopify documents a
-- different shape for each of the three, and the shapes differ in a
-- way the body cannot lie about without being re-signed:
--
--   customers/data_request  has customer, and orders_requested
--   customers/redact        has customer, and orders_to_redact
--   shop/redact             has neither — only the shop
--
-- So a delete only happens for a body that carries no customer at all.
-- A customer payload replayed as shop/redact no longer matches the
-- shape the verb requires, and is refused.
--
-- And 0058's cursor reset left imported alone. A pass restarted from
-- nothing then adds its full count on top of the partial count it
-- already had, which reads as more rows than the store holds — and
-- drift is measured from exactly that number, so it would have
-- reported rows missing that were never missing.
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
  v_customer := v_body#>>'{customer,id}';

  if v_shop is null or v_shop = '' then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  -- The topic has to agree with the body it arrived with. The topic is
  -- a header and the body is what was signed, so where they disagree
  -- the body wins and the request is refused.
  if p_topic = 'customers/data_request' then
    if v_customer is null then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return case when public.abo_shopify_data_request(v_shop, v_customer, v_body) then 1 else 0 end;

  elsif p_topic = 'customers/redact' then
    if v_customer is null then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_customer_redact(v_shop, v_customer);

  elsif p_topic = 'shop/redact' then
    -- The destructive one, so it is the strictest: a shop/redact body
    -- names no customer. A customer payload replayed under this topic
    -- carries one, and is refused here rather than deleting a store.
    if v_customer is not null or v_body ? 'customer' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  raise exception 'Unsigned.' using errcode = '42501';
end $$;

revoke all on function public.abo_shopify_compliance(text, text, text) from public;
grant execute on function public.abo_shopify_compliance(text, text, text) to anon, authenticated;

-- What 0058 should have zeroed. It is already applied, so the repair
-- belongs here: these runs were reset to pending with no cursor, and a
-- count of rows they no longer remember importing.
update public.import_runs
   set imported = 0
 where status = 'pending'
   and cursor is null
   and coalesce(imported, 0) <> 0;

NOTIFY pgrst, 'reload schema';
