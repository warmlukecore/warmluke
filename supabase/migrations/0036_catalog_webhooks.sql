-- Migration 0036: products, customers and stock arrive as they change.
--
-- Orders have been live since 0026. Everything else only moved when
-- somebody ran an import, so a price changed in Shopify at nine was
-- still wrong here at five — and nothing on the screen said it was
-- looking at yesterday.
--
-- Two columns first, because without them a stock webhook cannot be
-- matched to anything. Shopify's inventory payload names an inventory
-- item and a location by id; our rows key on a variant and a location
-- NAME, which that payload never carries.
--
-- Callers: src/app/api/shopify/webhooks/route.ts.

alter table public.variants
  add column if not exists inventory_item_id text;
alter table public.inventory_levels
  add column if not exists location_id text;

create index if not exists idx_variants_inventory_item
  on public.variants(store_id, inventory_item_id);

-- A level is one per variant per location. Matching by id is exact;
-- the name is what a person reads.
create unique index if not exists idx_inventory_levels_by_location_id
  on public.inventory_levels(store_id, variant_id, location_id)
  where location_id is not null;

-- ── Products ────────────────────────────────────────────────────
-- The REST payload differs from GraphQL in the two usual ways: ids are
-- bare numbers, and tags are one comma-separated string.
create or replace function public.abo_shopify_upsert_product(
  p_shop    text,
  p_product jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store   uuid;
  v_product uuid;
  v_ext     text;
  v_variant jsonb;
  v_n       integer := 0;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('Product', p_product->>'id');
  if v_ext is null then return 0; end if;

  insert into public.products (store_id, external_id, title, handle, status, tags, updated_at)
  values (
    v_store, v_ext, p_product->>'title', p_product->>'handle',
    upper(nullif(p_product->>'status', '')),
    coalesce(
      (select array_agg(btrim(t))
         from unnest(string_to_array(coalesce(p_product->>'tags', ''), ',')) as t
        where btrim(t) <> ''),
      '{}'::text[]
    ),
    coalesce((nullif(p_product->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update
    set title = excluded.title, handle = excluded.handle, status = excluded.status,
        tags = excluded.tags, updated_at = excluded.updated_at
  returning id into v_product;

  for v_variant in select * from jsonb_array_elements(coalesce(p_product->'variants', '[]'::jsonb))
  loop
    insert into public.variants (
      store_id, product_id, external_id, title, sku, barcode, price,
      inventory_item_id, updated_at
    ) values (
      v_store, v_product,
      public.abo_shopify_gid('ProductVariant', v_variant->>'id'),
      v_variant->>'title', v_variant->>'sku', v_variant->>'barcode',
      nullif(v_variant->>'price', '')::numeric,
      public.abo_shopify_gid('InventoryItem', v_variant->>'inventory_item_id'),
      coalesce((nullif(v_variant->>'updated_at', ''))::timestamptz, now())
    )
    on conflict (store_id, external_id) do update
      set product_id = excluded.product_id, title = excluded.title, sku = excluded.sku,
          barcode = excluded.barcode, price = excluded.price,
          inventory_item_id = coalesce(excluded.inventory_item_id, variants.inventory_item_id),
          updated_at = excluded.updated_at;
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

-- Gone from Shopify means gone here. A product left behind would show
-- in a section as though it were still for sale.
create or replace function public.abo_shopify_delete_product(
  p_shop text,
  p_id   text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_n integer;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;
  delete from public.products
   where store_id = v_store and external_id = public.abo_shopify_gid('Product', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── Customers ───────────────────────────────────────────────────
create or replace function public.abo_shopify_upsert_customer(
  p_shop     text,
  p_customer jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_ext text; v_name text;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('Customer', p_customer->>'id');
  if v_ext is null then return 0; end if;

  -- GraphQL hands back one displayName; REST sends the halves.
  v_name := nullif(btrim(concat_ws(' ', p_customer->>'first_name', p_customer->>'last_name')), '');

  insert into public.customers (
    store_id, external_id, name, email, phone, city, postal_code, tags, orders_count, updated_at
  ) values (
    v_store, v_ext, v_name, p_customer->>'email', p_customer->>'phone',
    p_customer#>>'{default_address,city}', p_customer#>>'{default_address,zip}',
    coalesce(
      (select array_agg(btrim(t))
         from unnest(string_to_array(coalesce(p_customer->>'tags', ''), ',')) as t
        where btrim(t) <> ''),
      '{}'::text[]
    ),
    coalesce(nullif(p_customer->>'orders_count', '')::integer, 0),
    coalesce((nullif(p_customer->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update
    set name = excluded.name, email = excluded.email, phone = excluded.phone,
        city = excluded.city, postal_code = excluded.postal_code, tags = excluded.tags,
        orders_count = excluded.orders_count, updated_at = excluded.updated_at;

  return 1;
end $$;

create or replace function public.abo_shopify_delete_customer(
  p_shop text,
  p_id   text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_n integer;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;
  delete from public.customers
   where store_id = v_store and external_id = public.abo_shopify_gid('Customer', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── Stock ───────────────────────────────────────────────────────
-- The payload names an inventory item, not a variant, which is why
-- variants now carry that id. A level for an item nobody has imported
-- is dropped rather than stored against nothing — the next import
-- brings both.
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
  if v_variant is null then return 0; end if;

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

revoke all on function public.abo_shopify_upsert_product(text, jsonb) from public;
revoke all on function public.abo_shopify_delete_product(text, text) from public;
revoke all on function public.abo_shopify_upsert_customer(text, jsonb) from public;
revoke all on function public.abo_shopify_delete_customer(text, text) from public;
revoke all on function public.abo_shopify_set_inventory(text, jsonb) from public;
-- Reachable by the webhook route, which holds only the anon key and
-- has already checked Shopify's signature before calling.
grant execute on function public.abo_shopify_upsert_product(text, jsonb) to anon, authenticated;
grant execute on function public.abo_shopify_delete_product(text, text) to anon, authenticated;
grant execute on function public.abo_shopify_upsert_customer(text, jsonb) to anon, authenticated;
grant execute on function public.abo_shopify_delete_customer(text, text) to anon, authenticated;
grant execute on function public.abo_shopify_set_inventory(text, jsonb) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
