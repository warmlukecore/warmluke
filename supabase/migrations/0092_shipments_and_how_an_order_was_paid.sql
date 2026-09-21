-- Migration 0092: shipments, and how an order was paid and where it went.
--
-- Three things a merchant asks about an order that the copy could not
-- answer: which courier has it and the tracking number ("delivery
-- partner and tracking number" was the commonest question with no
-- data behind it), whether it was COD or prepaid, and where it is
-- going. Shopify has all three; the import never asked.
--
-- Orders gain the gateway that paid, the discount codes used and the
-- shipping city, state and country. Shipments (Shopify's fulfillments)
-- get a table and a list of their own: one row per shipment with the
-- courier, tracking number and where it stands, imported by their own
-- pass over the fulfilled orders, and kept fresh three ways — the
-- order payload carries them, and fulfillments/create and /update
-- catch a tracking number added after the fact.
--
-- Callers: src/lib/shopify-import.ts (saveOrders, saveFulfillments),
-- src/lib/shopify-resources.ts (the fulfillments resource),
-- src/lib/store-read.ts (STORE_TABLES.fulfillments), the webhook
-- route through abo_shopify_webhook.

alter table public.orders
  add column if not exists gateway        text,
  add column if not exists discount_codes text[] not null default '{}',
  add column if not exists ship_city      text,
  add column if not exists ship_state     text,
  add column if not exists ship_country   text;

create table if not exists public.fulfillments (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  external_id     text not null,
  -- Whether it went out: SUCCESS, CANCELLED, ERROR, FAILURE.
  status          text,
  -- Where it is: IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, ... or
  -- FULFILLED when the courier says nothing.
  shipment_status text,
  carrier         text,
  -- Several parcels under one shipment carry several numbers, joined.
  tracking_number text,
  tracking_url    text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  updated_at      timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists idx_fulfillments_unique on public.fulfillments(store_id, external_id);
create index if not exists idx_fulfillments_order on public.fulfillments(order_id);
create index if not exists idx_fulfillments_store on public.fulfillments(store_id);

-- The two policies every commerce table has (0018).
alter table public.fulfillments enable row level security;
drop policy if exists "fulfillments_owner_all" on public.fulfillments;
create policy "fulfillments_owner_all" on public.fulfillments
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "fulfillments_member_read" on public.fulfillments;
create policy "fulfillments_member_read" on public.fulfillments
  for select using (public.abo_store_readable(store_id));

-- ── The lists ───────────────────────────────────────────────────
-- Columns are only ever added at the end here: Postgres lets a view be
-- replaced that way without dropping what depends on it.
create or replace view public.store_orders with (security_invoker = true) as
select
  o.id,
  o.store_id,
  o.order_number,
  to_char(o.placed_at, 'YYYY-MM-DD') as placed_at,
  c.name  as customer_name,
  c.phone as customer_phone,
  o.total,
  o.total_original,
  o.currency,
  case when o.cancelled_at is not null then 'Cancelled' else o.financial_status end as status,
  o.fulfilment_status,
  o.financial_status,
  o.cancelled_at,
  nullif(array_to_string(o.tags, ', '), '') as tags,
  o.gateway,
  nullif(array_to_string(o.discount_codes, ', '), '') as discount_codes,
  o.ship_city,
  o.ship_state,
  o.ship_country
from public.orders o
left join public.customers c on c.id = o.customer_id;

create or replace view public.store_fulfillments with (security_invoker = true) as
select
  f.id,
  f.store_id,
  f.order_id,
  o.order_number,
  c.name as customer_name,
  f.carrier,
  f.tracking_number,
  f.tracking_url,
  coalesce(f.shipment_status, f.status) as shipment_status,
  f.status,
  to_char(f.shipped_at, 'YYYY-MM-DD') as shipped_at,
  to_char(f.delivered_at, 'YYYY-MM-DD') as delivered_at
from public.fulfillments f
join public.orders o on o.id = f.order_id
left join public.customers c on c.id = o.customer_id;

grant select on public.store_fulfillments to authenticated;

-- The one mapping, one line longer (0089, 0090).
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
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- One shipment from REST's shape, written the way the import writes
-- it. Used by the order handler (the order payload carries every
-- shipment) and by the shipment topics.
create or replace function public.abo_shopify_put_fulfillment(p_store uuid, p_order uuid, p_f jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.abo_shopify_gid('Fulfillment', p_f->>'id') is null then return; end if;
  insert into public.fulfillments (
    store_id, order_id, external_id, status, shipment_status, carrier,
    tracking_number, tracking_url, shipped_at, delivered_at, updated_at
  ) values (
    p_store, p_order, public.abo_shopify_gid('Fulfillment', p_f->>'id'),
    upper(nullif(p_f->>'status', '')),
    upper(nullif(p_f->>'shipment_status', '')),
    nullif(p_f->>'tracking_company', ''),
    coalesce(
      nullif((select string_agg(n, ', ')
                from jsonb_array_elements_text(coalesce(p_f->'tracking_numbers', '[]'::jsonb)) as n
               where n <> ''), ''),
      nullif(p_f->>'tracking_number', '')
    ),
    coalesce(
      (select u from jsonb_array_elements_text(coalesce(p_f->'tracking_urls', '[]'::jsonb)) as u
        where u <> '' limit 1),
      nullif(p_f->>'tracking_url', '')
    ),
    (nullif(p_f->>'created_at', ''))::timestamptz,
    -- REST has no delivered_at; the moment it says delivered is the
    -- nearest thing, and it is kept once set.
    case when lower(p_f->>'shipment_status') = 'delivered'
         then (nullif(p_f->>'updated_at', ''))::timestamptz end,
    (nullif(p_f->>'updated_at', ''))::timestamptz
  )
  on conflict (store_id, external_id) do update set
    order_id        = excluded.order_id,
    status          = coalesce(excluded.status, public.fulfillments.status),
    shipment_status = coalesce(excluded.shipment_status, public.fulfillments.shipment_status),
    carrier         = coalesce(excluded.carrier, public.fulfillments.carrier),
    tracking_number = coalesce(excluded.tracking_number, public.fulfillments.tracking_number),
    tracking_url    = coalesce(excluded.tracking_url, public.fulfillments.tracking_url),
    shipped_at      = coalesce(excluded.shipped_at, public.fulfillments.shipped_at),
    delivered_at    = coalesce(public.fulfillments.delivered_at, excluded.delivered_at),
    updated_at      = coalesce(excluded.updated_at, public.fulfillments.updated_at);
end $$;

revoke all on function public.abo_shopify_put_fulfillment(uuid, uuid, jsonb) from public;
revoke execute on function public.abo_shopify_put_fulfillment(uuid, uuid, jsonb) from anon, authenticated;

-- fulfillments/create and fulfillments/update.
create or replace function public.abo_shopify_upsert_fulfillment(p_shop text, p_f jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_order uuid;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  select id into v_order from public.orders
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Order', p_f->>'order_id');
  -- An order not here yet is nothing to hang a shipment on; the next
  -- orders/updated carries the shipment again.
  if v_order is null then return 0; end if;

  perform public.abo_shopify_put_fulfillment(v_store, v_order, p_f);
  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_fulfillment(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_fulfillment(text, jsonb) from anon, authenticated;

-- The order handler (0091), now writing what paid, where it went, and
-- the shipments the payload carries.
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
  v_refund   jsonb;
  v_f        jsonb;
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

  select id into v_customer from public.customers
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Customer', p_order#>>'{customer,id}');

  insert into public.orders (
    store_id, external_id, order_number, customer_id, placed_at, total, total_original, currency,
    financial_status, fulfilment_status, cancelled_at, tags, source, updated_at,
    gateway, discount_codes, ship_city, ship_state, ship_country
  ) values (
    v_store, v_ext, p_order->>'name', v_customer,
    (nullif(p_order->>'created_at', ''))::timestamptz,
    nullif(coalesce(p_order->>'current_total_price', p_order->>'total_price'), '')::numeric,
    nullif(coalesce(p_order->>'total_price', p_order->>'current_total_price'), '')::numeric,
    p_order->>'currency',
    upper(nullif(p_order->>'financial_status', '')),
    upper(nullif(p_order->>'fulfillment_status', '')),
    (nullif(p_order->>'cancelled_at', ''))::timestamptz,
    coalesce(
      (select array_agg(btrim(t))
         from unnest(string_to_array(coalesce(p_order->>'tags', ''), ',')) as t
        where btrim(t) <> ''),
      '{}'::text[]
    ),
    'shopify',
    (nullif(p_order->>'updated_at', ''))::timestamptz,
    -- The first gateway is the one that paid; a gift card comes second.
    (select nullif(g, '')
       from jsonb_array_elements_text(coalesce(p_order->'payment_gateway_names', '[]'::jsonb)) as g
      limit 1),
    coalesce(
      (select array_agg(d->>'code')
         from jsonb_array_elements(coalesce(p_order->'discount_codes', '[]'::jsonb)) as d
        where coalesce(d->>'code', '') <> ''),
      '{}'::text[]
    ),
    nullif(p_order#>>'{shipping_address,city}', ''),
    nullif(p_order#>>'{shipping_address,province_code}', ''),
    nullif(p_order#>>'{shipping_address,country_code}', '')
  )
  on conflict (store_id, external_id) do update set
    order_number      = excluded.order_number,
    customer_id       = coalesce(excluded.customer_id, public.orders.customer_id),
    placed_at         = excluded.placed_at,
    total             = excluded.total,
    total_original    = coalesce(excluded.total_original, public.orders.total_original),
    currency          = excluded.currency,
    financial_status  = excluded.financial_status,
    fulfilment_status = excluded.fulfilment_status,
    cancelled_at      = excluded.cancelled_at,
    tags              = excluded.tags,
    updated_at        = excluded.updated_at,
    gateway           = coalesce(excluded.gateway, public.orders.gateway),
    discount_codes    = excluded.discount_codes,
    ship_city         = coalesce(excluded.ship_city, public.orders.ship_city),
    ship_state        = coalesce(excluded.ship_state, public.orders.ship_state),
    ship_country      = coalesce(excluded.ship_country, public.orders.ship_country)
  returning id into v_order;

  delete from public.order_line_items where order_id = v_order;

  for v_line in select * from jsonb_array_elements(coalesce(p_order->'line_items', '[]'::jsonb))
  loop
    insert into public.order_line_items (
      store_id, order_id, external_id, product_id, variant_id, title, variant_title, sku, quantity, price
    ) values (
      v_store, v_order,
      public.abo_shopify_gid('LineItem', v_line->>'id'),
      (select id from public.products where store_id = v_store
        and external_id = public.abo_shopify_gid('Product', v_line->>'product_id')),
      (select id from public.variants where store_id = v_store
        and external_id = public.abo_shopify_gid('ProductVariant', v_line->>'variant_id')),
      v_line->>'title', nullif(v_line->>'variant_title', ''), nullif(v_line->>'sku', ''),
      (v_line->>'quantity')::integer,
      nullif(v_line->>'price', '')::numeric
    );
    v_lines := v_lines + 1;
  end loop;

  for v_refund in select * from jsonb_array_elements(coalesce(p_order->'refunds', '[]'::jsonb))
  loop
    if public.abo_shopify_gid('Refund', v_refund->>'id') is null then continue; end if;
    insert into public.refunds (store_id, order_id, external_id, amount, quantity, refunded_at)
    values (
      v_store, v_order,
      public.abo_shopify_gid('Refund', v_refund->>'id'),
      coalesce(
        (select sum(nullif(t->>'amount', '')::numeric)
           from jsonb_array_elements(coalesce(v_refund->'transactions', '[]'::jsonb)) as t
          where coalesce(t->>'kind', 'refund') = 'refund'
            and coalesce(t->>'status', 'success') = 'success'),
        (select sum(nullif(li->>'subtotal', '')::numeric)
           from jsonb_array_elements(coalesce(v_refund->'refund_line_items', '[]'::jsonb)) as li),
        0
      ),
      coalesce(
        (select sum((li->>'quantity')::integer)
           from jsonb_array_elements(coalesce(v_refund->'refund_line_items', '[]'::jsonb)) as li),
        0
      ),
      (nullif(v_refund->>'created_at', ''))::timestamptz
    )
    on conflict (store_id, external_id) do update set
      order_id    = excluded.order_id,
      amount      = excluded.amount,
      quantity    = excluded.quantity,
      refunded_at = excluded.refunded_at;
  end loop;

  -- Shipments ride inside the order too.
  for v_f in select * from jsonb_array_elements(coalesce(p_order->'fulfillments', '[]'::jsonb))
  loop
    perform public.abo_shopify_put_fulfillment(v_store, v_order, v_f);
  end loop;

  update public.stores set last_synced_at = now() where id = v_store;

  return v_lines;
end $function$
;

-- The dispatcher (0058), two topics longer.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
