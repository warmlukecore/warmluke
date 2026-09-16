-- Migration 0056: three ways yesterday's fixes were still open.
--
-- 1. The second signature could be stepped over. 0055 compares a MAC
--    over topic, shop and body — but `<>` against a null is null, and
--    plpgsql reads a null IF as false, so a caller who simply left the
--    topic or the shop out skipped the check. Nothing was written
--    then, because the dispatch needs both; the danger is the next
--    topic somebody adds that reads its shop from the body. A check
--    that can be stepped over is worse than no check, because it looks
--    like one.
--
-- 2. Refunds were never keyed on anything. They upsert on conflict of
--    `id`, which is a generated uuid the importer never supplies, so
--    every pass INSERTED them again — and the paged-to-bulk switch
--    added yesterday makes a second pass over the same orders much
--    more likely. No store here has a refund yet, which is the only
--    reason nobody has seen four copies of one.
--
-- 3. last_synced_at was read and then written, which is not the same
--    as only moving forward. A webhook landing between the two puts a
--    newer time in, and the write that follows still drags it back.
--    The comparison belongs in the statement.
--
-- Callers: src/app/api/shopify/webhooks/route.ts,
-- src/lib/shopify-import.ts, src/app/api/shopify/import/route.ts.

-- A refund is the one Shopify says it is.
--
-- The copies the old upsert already made go first: over them the index
-- cannot be built, and the migration would stop here — taking the
-- signature fix below with it, on the very database that collected the
-- duplicates.
-- One statement, so the lock is still held when the index is built.
-- Held apart, an import can insert another copy in between and the
-- index creation fails — taking the signature fix below with it.
do $$
begin
  lock table public.refunds in share row exclusive mode;

  -- These are copies of one refund, so which one stays does not
  -- matter; it only has to be decided the same way every time. The
  -- lowest uuid keeps it deterministic and says nothing more than
  -- that — uuids here are random, not chronological.
  delete from public.refunds a
   using public.refunds b
   where a.store_id = b.store_id
     and a.external_id = b.external_id
     and a.id > b.id;

  execute 'create unique index if not exists idx_refunds_unique
             on public.refunds(store_id, external_id)';
end $$;

-- Forward only, decided while the row is locked.
create or replace function public.abo_store_synced(
  p_store uuid,
  p_at    timestamptz
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if p_at is null then return null; end if;

  update public.stores
     set last_synced_at = greatest(coalesce(last_synced_at, p_at), p_at)
   where id = p_store
     and public.abo_owns(project_id)
  returning last_synced_at into v_at;

  return v_at;
end $$;

revoke all on function public.abo_store_synced(uuid, timestamptz) from public;
grant execute on function public.abo_store_synced(uuid, timestamptz) to authenticated;

create or replace function public.abo_shopify_webhook(
  p_topic text,
  p_shop  text,
  p_raw   text,
  p_hmac  text,
  p_sig   text
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

  -- And the topic and shop are signed too.
  --
  -- Shopify signs the body and nothing else; which store it came from
  -- and what happened travel in headers. Those arrived here as plain
  -- arguments, and this function is reachable with the public anon
  -- key — so a merchant who captured one of their own signed
  -- deliveries could send it back naming somebody else's shop, and we
  -- would write their product into another merchant's store.
  --
  -- The route reads the headers and signs all three with the same app
  -- secret. Anyone holding a captured body still cannot say where it
  -- came from.
  -- Null is not a pass. <> against a null yields null, and plpgsql
  -- treats a null IF as false — so leaving out the topic or the shop
  -- skipped this check entirely. Nothing was written, because the
  -- dispatch needs both, but a security check that can be stepped
  -- over is a trap set for whoever adds the next topic.
  if p_topic is null or p_shop is null or p_sig is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(
       extensions.hmac(p_topic || E'\n' || p_shop || E'\n' || p_raw, v_secret, 'sha256'),
       'base64'
     ) is distinct from p_sig then
    raise exception 'Unsigned.' using errcode = '42501';
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

revoke all on function public.abo_shopify_webhook(text, text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
