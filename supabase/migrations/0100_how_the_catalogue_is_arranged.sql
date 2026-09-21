-- Migration 0100: how the catalogue is arranged.
--
-- The copy has held products since the first import and nothing about
-- how the merchant groups them. So "what is in the sale", "which
-- collection is this in" and "how many are in each" were questions
-- about a shop this app could see and could not answer.
--
-- Two tables, because a collection is a thing and belonging to one is
-- a fact about a pair. The membership is what makes both questions
-- answerable from either end.
--
-- Under read_products, which has been granted since the first
-- install. No reconnect.
--
-- Callers: src/lib/shopify-import.ts (saveCollections), the
-- collections resource in src/lib/shopify-resources.ts,
-- STORE_TABLES.collections and COUNTED in src/lib/store-read.ts, and
-- the webhook route through abo_shopify_webhook.

create table if not exists public.collections (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id) on delete cascade,
  external_id    text not null,
  title          text,
  handle         text,
  -- How Shopify orders it on the storefront: MANUAL, BEST_SELLING,
  -- ALPHA_ASC and so on.
  sort_order     text,
  -- Shopify's own count of the whole collection, which is not the
  -- same as how many memberships we hold: a paged read stops at a
  -- hundred, and knowing that the real number is four hundred is
  -- what lets an answer say so.
  products_count integer,
  updated_at     timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists idx_collections_unique on public.collections(store_id, external_id);
create index if not exists idx_collections_store on public.collections(store_id);

create table if not exists public.collection_products (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  created_at    timestamptz not null default now()
);
create unique index if not exists idx_collection_products_unique
  on public.collection_products(collection_id, product_id);
create index if not exists idx_collection_products_product on public.collection_products(product_id);
create index if not exists idx_collection_products_store on public.collection_products(store_id);

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
do $$
declare t text;
begin
  foreach t in array array['collections', 'collection_products'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all
         using (public.abo_store_owned(store_id))
         with check (public.abo_store_owned(store_id))', t, t);

    execute format('drop policy if exists "%s_member_read" on public.%I', t, t);
    execute format(
      'create policy "%s_member_read" on public.%I for select
         using (public.abo_store_readable(store_id))', t, t);

    execute format('drop policy if exists "%s_oauth_no_insert" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_insert" on public.%I as restrictive
         for insert to authenticated
         with check (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_update" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_update" on public.%I as restrictive
         for update to authenticated
         using (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_delete" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_delete" on public.%I as restrictive
         for delete to authenticated
         using (not public.abo_is_oauth_client())', t, t);
  end loop;
end $$;

create or replace view public.store_collections with (security_invoker = true) as
select
  c.id,
  c.store_id,
  c.title,
  c.handle,
  c.sort_order,
  -- What Shopify says is in it, beside what we actually hold. They
  -- differ while a big collection is still coming across, and a
  -- merchant reading "12" when Shopify says 400 deserves to see both.
  c.products_count,
  (select count(*) from public.collection_products cp where cp.collection_id = c.id) as products_here
from public.collections c;

grant select on public.store_collections to authenticated;

-- Which collections a product belongs to, on the product itself.
-- Cheaper than a list of its own and it answers the question from the
-- end a merchant usually asks it: they are looking at a product.
create or replace view public.store_products with (security_invoker = true) as
select
  p.id,
  p.store_id,
  p.title,
  p.product_type,
  p.vendor,
  p.handle,
  p.status,
  nullif(array_to_string(p.tags, ', '), '') as tags,
  (select nullif(string_agg(c.title, ', ' order by c.title), '')
     from public.collection_products cp
     join public.collections c on c.id = cp.collection_id
    where cp.product_id = p.id) as collections
from public.products p;

grant select on public.store_products to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092, 0095, 0099).
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'           then 'store_orders'
    when 'customers'        then 'store_customers'
    when 'products'         then 'store_products'
    when 'inventory_levels' then 'store_inventory'
    when 'product_sales'    then 'product_sales'
    when 'order_line_items' then 'store_order_items'
    when 'refunds'          then 'store_refunds'
    when 'variants'         then 'store_variants'
    when 'fulfillments'     then 'store_fulfillments'
    when 'transactions'     then 'store_transactions'
    when 'locations'        then 'store_locations'
    when 'collections'      then 'store_collections'
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- A collection payload names the collection. It does not carry what
-- is inside, so the membership is left exactly as the import left it
-- rather than being emptied by a rename.
create or replace function public.abo_shopify_upsert_collection(p_shop text, p_c jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_ext   text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('Collection', p_c->>'id');
  if v_ext is null then return 0; end if;

  insert into public.collections (store_id, external_id, title, handle, sort_order, updated_at)
  values (
    v_store, v_ext,
    nullif(p_c->>'title', ''),
    nullif(p_c->>'handle', ''),
    upper(nullif(p_c->>'sort_order', '')),
    coalesce((nullif(p_c->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    title      = coalesce(excluded.title, public.collections.title),
    handle     = coalesce(excluded.handle, public.collections.handle),
    sort_order = coalesce(excluded.sort_order, public.collections.sort_order),
    updated_at = excluded.updated_at;

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_collection(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_collection(text, jsonb) from anon, authenticated;

-- Deleted in Shopify means gone here: unlike a location, nothing else
-- points at a collection, so leaving it would only be a lie about
-- what the shop has.
create or replace function public.abo_shopify_delete_collection(p_shop text, p_id text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_n     integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null or public.abo_shopify_gid('Collection', p_id) is null then return 0; end if;

  delete from public.collections
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Collection', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.abo_shopify_delete_collection(text, text) from public;
revoke execute on function public.abo_shopify_delete_collection(text, text) from anon, authenticated;

-- The dispatcher (0099), three topics longer.
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
  elsif p_topic in ('fulfillments/create', 'fulfillments/update') then
    return public.abo_shopify_upsert_fulfillment(v_shop, v_body);
  elsif p_topic = 'order_transactions/create' then
    return public.abo_shopify_upsert_transaction(v_shop, v_body);
  elsif p_topic in ('locations/create', 'locations/update',
                    'locations/activate', 'locations/deactivate') then
    return public.abo_shopify_upsert_location(v_shop, v_body);
  elsif p_topic = 'locations/delete' then
    return public.abo_shopify_delete_location(v_shop, v_body->>'id');
  elsif p_topic in ('collections/create', 'collections/update') then
    return public.abo_shopify_upsert_collection(v_shop, v_body);
  elsif p_topic = 'collections/delete' then
    return public.abo_shopify_delete_collection(v_shop, v_body->>'id');
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
