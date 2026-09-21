-- Migration 0098: what the total is made of.
--
-- An order has carried one number for money: the total. So the only
-- sentence the app could say was "you sold 4,942", and that number
-- quietly contains tax the merchant owes somebody else and postage
-- they collected on behalf of a courier. Neither is theirs. A
-- merchant reading it as income is reading it wrong, and nothing
-- here was in a position to tell them.
--
-- total = subtotal + shipping + tax, with the discount already taken
-- off the subtotal. Those four are what Shopify has been handing over
-- all along under read_orders.
--
-- Null, never zero, when the field did not come. A bulk file written
-- before today says nothing about tax, and a shop that charges no tax
-- says zero; showing both as zero makes the first into the second.
--
-- The current values where Shopify has them, matching what 0080
-- decided for the total itself: these are what the order comes to
-- today, after refunds, not what it came to when placed. Shipping has
-- no "current" — a refunded postage charge still shows as charged,
-- which is Shopify's own behaviour and not ours to improve on.
--
-- Callers: src/lib/shopify-import.ts (saveOrders), STORE_TABLES.orders
-- in src/lib/store-read.ts, and the webhook route through
-- abo_shopify_upsert_order.

alter table public.orders
  -- Goods, after any discount, before shipping and tax.
  add column if not exists subtotal numeric(12,2),
  -- Owed to a tax authority. Never the merchant's income.
  add column if not exists tax      numeric(12,2),
  -- Charged to the customer for delivery. Usually paid straight out
  -- again to whoever carried it.
  add column if not exists shipping numeric(12,2),
  -- Given away. The gap between what the goods list at and what they
  -- were sold for.
  add column if not exists discount numeric(12,2);

comment on column public.orders.subtotal is
  'Goods after discount, before shipping and tax. Null means the import has not seen it, not zero.';
comment on column public.orders.tax is
  'Tax charged on the order. Money owed onward, never revenue.';

-- Columns only ever added at the end, so the view is replaced without
-- dropping what depends on it.
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
  o.ship_country,
  o.subtotal,
  o.tax,
  o.shipping,
  o.discount
from public.orders o
left join public.customers c on c.id = o.customer_id;

-- The webhook road, writing the same four. REST spells them flat and
-- in snake case, and has both a plain and a "current" form for three
-- of them; shipping arrives only inside a money set, or as lines to
-- add up when even that is missing.
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
    gateway, discount_codes, ship_city, ship_state, ship_country,
    subtotal, tax, shipping, discount
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
    nullif(p_order#>>'{shipping_address,country_code}', ''),
    nullif(coalesce(p_order->>'current_subtotal_price', p_order->>'subtotal_price'), '')::numeric,
    nullif(coalesce(p_order->>'current_total_tax', p_order->>'total_tax'), '')::numeric,
    -- Shipping is not a top-level field on this road. The money set
    -- when it is there, and the lines added up when it is not; a
    -- split delivery is two lines and one charge.
    coalesce(
      nullif(p_order#>>'{total_shipping_price_set,shop_money,amount}', '')::numeric,
      (select sum(nullif(sl->>'price', '')::numeric)
         from jsonb_array_elements(coalesce(p_order->'shipping_lines', '[]'::jsonb)) as sl)
    ),
    nullif(coalesce(p_order->>'current_total_discounts', p_order->>'total_discounts'), '')::numeric
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
    ship_country      = coalesce(excluded.ship_country, public.orders.ship_country),
    -- Kept when this payload is silent about them, because a webhook
    -- that says nothing about tax must not erase the tax an import
    -- read a minute ago.
    subtotal          = coalesce(excluded.subtotal, public.orders.subtotal),
    tax               = coalesce(excluded.tax,      public.orders.tax),
    shipping          = coalesce(excluded.shipping, public.orders.shipping),
    discount          = coalesce(excluded.discount, public.orders.discount)
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

  for v_f in select * from jsonb_array_elements(coalesce(p_order->'fulfillments', '[]'::jsonb))
  loop
    perform public.abo_shopify_put_fulfillment(v_store, v_order, v_f);
  end loop;

  update public.stores set last_synced_at = now() where id = v_store;

  return v_lines;
end $function$
;

NOTIFY pgrst, 'reload schema';
