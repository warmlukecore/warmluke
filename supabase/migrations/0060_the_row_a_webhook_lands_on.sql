-- Migration 0060: the row a webhook lands on.
--
-- 0054 let several people be mid-install for one domain at once, which
-- was right: a stranger typing somebody else's myshopify address must
-- not be able to hold it for ever. Pending rows therefore sit outside
-- the unique index, and several rows can carry the same shop_domain.
--
-- Every webhook handler then did this:
--
--     select id into v_store from public.stores where shop_domain = p_shop;
--
-- No provider, no status. With a pending row in the way that matches
-- arbitrarily — plpgsql takes the first row and does not complain —
-- and an attacker who started an install for a shop they do not own
-- could be handed that shop's orders, customers and products.
--
-- 0057 and 0058 made the DISPATCHER resolve the store correctly and
-- then passed a shop_domain to these helpers, which looked it up all
-- over again with no such care. Resolving safely and then asking the
-- question again loosely is the same as never resolving it.
--
-- Each of the nine now names the one row it means. Case-folded to
-- match 0057's index, which is unique on lower(shop_domain).
--
-- Callers: every Shopify webhook path.
;

CREATE OR REPLACE FUNCTION public.abo_shopify_customer_redact(p_shop text, p_customer text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid; v_deleted integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  delete from public.customers
   where store_id = v_store
     and external_id = public.abo_shopify_customer_key(p_customer);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_data_request(p_shop text, p_customer text, p_payload jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then
    return false;  -- not a store of ours; nothing is held to hand over
  end if;

  insert into public.shopify_data_requests (store_id, customer_external_id, payload)
  values (v_store, public.abo_shopify_customer_key(p_customer), p_payload);
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_delete_customer(p_shop text, p_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid; v_n integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;
  delete from public.customers
   where store_id = v_store and external_id = public.abo_shopify_gid('Customer', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_delete_product(p_shop text, p_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid; v_n integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;
  delete from public.products
   where store_id = v_store and external_id = public.abo_shopify_gid('Product', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_set_inventory(p_shop text, p_level jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid; v_variant uuid; v_loc text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
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
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_shop_redact(p_shop text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_deleted integer;
begin
  delete from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_upsert_customer(p_shop text, p_customer jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid; v_ext text; v_name text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
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
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_upsert_order(p_shop text, p_order jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_store    uuid;
  v_order    uuid;
  v_customer uuid;
  v_ext      text;
  v_line     jsonb;
  v_lines    integer := 0;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('Order', p_order->>'id');
  if v_ext is null then return 0; end if;

  -- The customer may not be imported yet. An order without its buyer is
  -- still an order; the link fills in on the next full import rather
  -- than the order being dropped.
  select id into v_customer from public.customers
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Customer', p_order#>>'{customer,id}');

  insert into public.orders (
    store_id, external_id, order_number, customer_id, placed_at, total, currency,
    financial_status, fulfilment_status, cancelled_at, tags, source, updated_at
  ) values (
    v_store, v_ext, p_order->>'name', v_customer,
    (nullif(p_order->>'created_at', ''))::timestamptz,
    nullif(coalesce(p_order->>'current_total_price', p_order->>'total_price'), '')::numeric,
    p_order->>'currency',
    upper(nullif(p_order->>'financial_status', '')),
    upper(nullif(p_order->>'fulfillment_status', '')),
    (nullif(p_order->>'cancelled_at', ''))::timestamptz,
    -- "cod, priority" is one string here and an array in GraphQL.
    coalesce(
      (select array_agg(btrim(t))
         from unnest(string_to_array(coalesce(p_order->>'tags', ''), ',')) as t
        where btrim(t) <> ''),
      '{}'::text[]
    ),
    'shopify',
    (nullif(p_order->>'updated_at', ''))::timestamptz
  )
  on conflict (store_id, external_id) do update set
    order_number      = excluded.order_number,
    customer_id       = coalesce(excluded.customer_id, public.orders.customer_id),
    placed_at         = excluded.placed_at,
    total             = excluded.total,
    currency          = excluded.currency,
    financial_status  = excluded.financial_status,
    fulfilment_status = excluded.fulfilment_status,
    cancelled_at      = excluded.cancelled_at,
    tags              = excluded.tags,
    updated_at        = excluded.updated_at
  returning id into v_order;

  -- Lines are replaced, not merged: an order edited in Shopify can lose
  -- a line, and merging would leave the removed one behind for ever.
  delete from public.order_line_items where order_id = v_order;

  for v_line in select * from jsonb_array_elements(coalesce(p_order->'line_items', '[]'::jsonb))
  loop
    insert into public.order_line_items (
      store_id, order_id, external_id, product_id, variant_id, title, sku, quantity, price
    ) values (
      v_store, v_order,
      public.abo_shopify_gid('LineItem', v_line->>'id'),
      (select id from public.products where store_id = v_store
        and external_id = public.abo_shopify_gid('Product', v_line->>'product_id')),
      (select id from public.variants where store_id = v_store
        and external_id = public.abo_shopify_gid('ProductVariant', v_line->>'variant_id')),
      v_line->>'title', nullif(v_line->>'sku', ''),
      (v_line->>'quantity')::integer,
      nullif(v_line->>'price', '')::numeric
    );
    v_lines := v_lines + 1;
  end loop;

  -- The copy is current as of now, which is what the assistant reports.
  update public.stores set last_synced_at = now() where id = v_store;

  return v_lines;
end $function$
;

CREATE OR REPLACE FUNCTION public.abo_shopify_upsert_product(p_shop text, p_product jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_store   uuid;
  v_product uuid;
  v_ext     text;
  v_variant jsonb;
  v_n       integer := 0;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
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
end $function$

;

NOTIFY pgrst, 'reload schema';
