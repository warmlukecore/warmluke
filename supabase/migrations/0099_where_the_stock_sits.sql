-- Migration 0099: where the stock sits.
--
-- A stock level has always named its location, so the name was in the
-- copy — but only ever as a label stuck on a quantity. Which places
-- exist, which are switched off, and where they actually are was not
-- something the app could answer. "How much is in the Pune warehouse"
-- needs the second half, and so does "why is this stock not selling",
-- whose answer is often that the location holding it is off.
--
-- read_locations has been granted since the first install. This is the
-- resource that finally asks for it.
--
-- A location switched off, or deleted in Shopify, is kept and marked
-- rather than removed: its stock rows and the orders it shipped still
-- point at it, and a name that vanishes turns those into puzzles.
--
-- Callers: src/lib/shopify-import.ts (saveLocations), the locations
-- resource in src/lib/shopify-resources.ts, STORE_TABLES.locations and
-- COUNTED in src/lib/store-read.ts, and the webhook route through
-- abo_shopify_webhook.

create table if not exists public.locations (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references public.stores(id) on delete cascade,
  external_id            text not null,
  name                   text,
  -- Off means its stock cannot be sold. The rows stay either way.
  active                 boolean,
  fulfills_online_orders boolean,
  address1               text,
  city                   text,
  province               text,
  province_code          text,
  country                text,
  country_code           text,
  zip                    text,
  -- Set when Shopify says it is gone. Kept, because stock levels and
  -- old orders still name it.
  deleted_at             timestamptz,
  updated_at             timestamptz,
  created_at             timestamptz not null default now()
);
create unique index if not exists idx_locations_unique on public.locations(store_id, external_id);
create index if not exists idx_locations_store on public.locations(store_id);

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
alter table public.locations enable row level security;
drop policy if exists "locations_owner_all" on public.locations;
create policy "locations_owner_all" on public.locations
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "locations_member_read" on public.locations;
create policy "locations_member_read" on public.locations
  for select using (public.abo_store_readable(store_id));

drop policy if exists "locations_oauth_no_insert" on public.locations;
create policy "locations_oauth_no_insert"
  on public.locations as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "locations_oauth_no_update" on public.locations;
create policy "locations_oauth_no_update"
  on public.locations as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "locations_oauth_no_delete" on public.locations;
create policy "locations_oauth_no_delete"
  on public.locations as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

-- Stock levels name their location by Shopify's id, which is what
-- joins the two here. Counted rather than summed: on_hand is only as
-- old as the last import, and a count of what is stocked there is the
-- question a locations list is actually opened for.
create or replace view public.store_locations with (security_invoker = true) as
select
  l.id,
  l.store_id,
  l.name,
  case
    when l.deleted_at is not null then 'Removed'
    when l.active is false        then 'Switched off'
    else 'Open'
  end as state,
  nullif(concat_ws(', ', nullif(l.city, ''), nullif(l.province, ''), nullif(l.country, '')), '') as place,
  l.zip,
  l.fulfills_online_orders,
  (select count(*) from public.inventory_levels i
    where i.store_id = l.store_id and i.location_id = l.external_id) as variants_stocked,
  (select coalesce(sum(i.available), 0) from public.inventory_levels i
    where i.store_id = l.store_id and i.location_id = l.external_id) as units_available
from public.locations l;

grant select on public.store_locations to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092, 0095).
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
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- create, update, activate and deactivate all carry the location, so
-- one upsert serves them. REST says "active" where GraphQL says
-- isActive, and an activate payload differs from an update payload
-- only in that field.
create or replace function public.abo_shopify_upsert_location(p_shop text, p_loc jsonb)
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

  v_ext := public.abo_shopify_gid('Location', p_loc->>'id');
  if v_ext is null then return 0; end if;

  insert into public.locations (
    store_id, external_id, name, active, fulfills_online_orders,
    address1, city, province, province_code, country, country_code, zip, updated_at
  ) values (
    v_store, v_ext,
    nullif(p_loc->>'name', ''),
    (p_loc->>'active')::boolean,
    nullif(p_loc->>'fulfills_online_orders', '')::boolean,
    nullif(p_loc->>'address1', ''),
    nullif(p_loc->>'city', ''),
    nullif(p_loc->>'province', ''),
    nullif(p_loc->>'province_code', ''),
    nullif(p_loc->>'country', ''),
    nullif(p_loc->>'country_code', ''),
    nullif(p_loc->>'zip', ''),
    coalesce((nullif(p_loc->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    name                   = coalesce(excluded.name, public.locations.name),
    active                 = coalesce(excluded.active, public.locations.active),
    fulfills_online_orders = coalesce(excluded.fulfills_online_orders, public.locations.fulfills_online_orders),
    address1               = coalesce(excluded.address1, public.locations.address1),
    city                   = coalesce(excluded.city, public.locations.city),
    province               = coalesce(excluded.province, public.locations.province),
    province_code          = coalesce(excluded.province_code, public.locations.province_code),
    country                = coalesce(excluded.country, public.locations.country),
    country_code           = coalesce(excluded.country_code, public.locations.country_code),
    zip                    = coalesce(excluded.zip, public.locations.zip),
    -- Coming back is a real event: a location reactivated in Shopify
    -- must stop reading as removed here.
    deleted_at             = null,
    updated_at             = excluded.updated_at;

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_location(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_location(text, jsonb) from anon, authenticated;

-- Marked, never removed: stock levels and old orders still name it.
create or replace function public.abo_shopify_delete_location(p_shop text, p_id text)
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
  if v_store is null or public.abo_shopify_gid('Location', p_id) is null then return 0; end if;

  update public.locations
     set deleted_at = now(), active = false
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Location', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.abo_shopify_delete_location(text, text) from public;
revoke execute on function public.abo_shopify_delete_location(text, text) from anon, authenticated;

-- The dispatcher (0098), five topics longer.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
