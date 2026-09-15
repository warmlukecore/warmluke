-- Migration 0042: the field that means "category".
--
-- A merchant asked for products grouped by category and was told it
-- could not be done. That was true, and it had nothing to do with the
-- design format or with safety: Shopify calls it productType, and the
-- importer never asked for it. Four columns came across — title,
-- handle, status, tags — and a category filter cannot be built out of
-- those.
--
-- vendor comes with it. It is the other question merchants ask of a
-- catalogue ("everything from this supplier"), it arrives in the same
-- response, and fetching it later would mean a second full import.
--
-- Callers: src/lib/shopify-import.ts, src/lib/shopify-bulk.ts,
-- src/lib/store-read.ts, and abo_shopify_upsert_product below.

alter table public.products
  add column if not exists product_type text,
  add column if not exists vendor       text;

-- Both are filtered on, and a filter that scans the table is the kind
-- of thing nobody notices until a store has fifty thousand products.
create index if not exists idx_products_type
  on public.products(store_id, product_type);
create index if not exists idx_products_vendor
  on public.products(store_id, vendor);

-- The webhook writes the same two. REST spells them product_type and
-- vendor; GraphQL says productType and vendor. Everything else in
-- this function is unchanged.
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

  insert into public.products
    (store_id, external_id, title, handle, status, product_type, vendor, tags, updated_at)
  values (
    v_store, v_ext, p_product->>'title', p_product->>'handle',
    upper(nullif(p_product->>'status', '')),
    nullif(btrim(p_product->>'product_type'), ''),
    nullif(btrim(p_product->>'vendor'), ''),
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
        product_type = excluded.product_type, vendor = excluded.vendor,
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

NOTIFY pgrst, 'reload schema';
