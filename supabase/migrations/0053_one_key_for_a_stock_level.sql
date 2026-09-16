-- Migration 0053: one key for a stock level, not two.
--
-- A level was unique twice over: once on (store, variant, location
-- NAME) for the importer, and once on (store, variant, location ID)
-- for the webhook. Two keys for one fact, and they disagree about
-- what a location is.
--
-- The name is the wrong half. Two locations are allowed to share a
-- name — "Warehouse" at two addresses is ordinary — and the name key
-- then folds both into a single row, so one shop's stock quietly
-- overwrites the other's. A location can also be renamed, and the
-- importer would look for a row that no longer answers to that name.
--
-- The id is stable and is what Shopify means by a location, so that
-- is the key. The partial predicate goes with it: supabase-js can name
-- conflict columns but not a WHERE, so a partial index cannot be the
-- target of the importer's upsert at all.
--
-- Checked against the live data before writing this: no row has a null
-- location_id, and nothing is duplicated under the id key, so nothing
-- has to be merged first.
--
-- Callers: src/lib/shopify-import.ts, and abo_shopify_set_inventory
-- below.

drop index if exists public.idx_inventory_unique;
drop index if exists public.idx_inventory_levels_by_location_id;

create unique index if not exists idx_inventory_unique
  on public.inventory_levels(store_id, variant_id, location_id);

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
  on conflict (store_id, variant_id, location_id)
  do update set available = excluded.available, updated_at = excluded.updated_at;

  return 1;
end $$;

NOTIFY pgrst, 'reload schema';
