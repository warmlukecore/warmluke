-- Migration 0052: stock that arrives early stops being thrown away.
--
-- A level for a variant nobody had imported was dropped, and Shopify
-- was told the delivery succeeded — so it never sent that number
-- again. Creating a product in Shopify fires two webhooks with no
-- guaranteed order, so the common case was: stock lands first, is
-- discarded, and the product arrives a second later with a quantity
-- that is now permanently wrong.
--
-- The comment beside the old code said "the next import brings both".
-- It does not: once every resource is marked done, the importer stops
-- reading Shopify at all and only moves last_synced_at forward.
--
-- Wrong stock is the worst thing in this database to be quietly wrong
-- about. It is what a merchant reads before promising a delivery.
--
-- Callers: supabase/migrations/0037_webhook_gate.sql (the dispatcher),
-- src/app/api/shopify/webhooks/route.ts (which turns the error into
-- the 500 Shopify retries on).

create or replace function public.abo_shopify_set_inventory(
  p_shop  text,
  p_level jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_variant uuid; v_loc text;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;

  select id into v_variant from public.variants
   where store_id = v_store
     and inventory_item_id = public.abo_shopify_gid('InventoryItem', p_level->>'inventory_item_id');

  -- Not ours to ignore. A stock level for a variant we have not seen
  -- almost always means the two webhooks arrived out of order — the
  -- product is seconds behind — and answering "fine" to Shopify means
  -- it never sends this number again. Raising makes the route answer
  -- 500, which is Shopify's signal to try later, by which time the
  -- product has landed.
  --
  -- ponytail: Shopify gives up after about two days of retries, and a
  -- topic that keeps failing can be removed altogether. The backstop
  -- is the reconciliation import, not more retries here.
  if v_variant is null then
    raise exception 'inventory arrived before its product (item %)',
      coalesce(p_level->>'inventory_item_id', '?')
      using errcode = '55006';
  end if;

  v_loc := public.abo_shopify_gid('Location', p_level->>'location_id');

  insert into public.inventory_levels (
    store_id, variant_id, location_id, location_name, available, updated_at
  ) values (
    v_store, v_variant, v_loc,
    -- The name is not in the payload. Keep whatever an import found
    -- for this location rather than blanking a label somebody reads.
    coalesce(
      (select location_name from public.inventory_levels
        where store_id = v_store and location_id = v_loc limit 1),
      ''
    ),
    coalesce(nullif(p_level->>'available', '')::integer, 0),
    coalesce((nullif(p_level->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, variant_id, location_id) where location_id is not null
  do update set available = excluded.available, updated_at = excluded.updated_at;

  return 1;
end $$;

NOTIFY pgrst, 'reload schema';
