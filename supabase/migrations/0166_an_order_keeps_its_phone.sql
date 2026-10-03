-- Migration 0166: an order keeps its phone
--
-- 2,487 orders on one store, and 198 showed a phone. The list read the
-- phone from the customer's record only, and a buyer in India checking
-- out with cash on delivery types theirs on the delivery address: the
-- customer record mostly has an email and nothing else. Now an order
-- keeps the phones Shopify gives it (its own, the delivery's, the
-- billing's), the list shows the first there is (delivery, order,
-- billing, then the customer's), and the customers list falls back to
-- the newest phone on their orders.
--
-- And the newest order comes first: the list's dates are the shop's
-- days (0162), so within a day it ran oldest first, and ordering by the
-- day, an expression, could use no index, so every page sorted the
-- store's whole list. It now orders by the moment itself (placed_ts),
-- on the index the orders table already has.
--
-- Old orders get their phones from the next Check (a recheck walks
-- every order again); new ones as they come.

alter table public.orders
  add column if not exists phone      text,
  add column if not exists ship_phone text,
  add column if not exists bill_phone text;

-- The newest phone on a customer's orders, beside Shopify's own field
-- (which the next customer sync would put back): kept by the orders,
-- read by the list.
alter table public.customers add column if not exists order_phone text;

create or replace function public.abo_customer_order_phone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The newest phone across all of a customer's orders, not the newest
  -- of those just written: a refund on last year's order must not put
  -- last year's number back. On idx_orders_customer.
  update public.customers c
     set order_phone = x.phone
    from (select distinct on (o.customer_id) o.customer_id, coalesce(o.ship_phone, o.phone, o.bill_phone) as phone
            from public.orders o
           where o.customer_id in (select distinct customer_id from changed where customer_id is not null)
             and coalesce(o.ship_phone, o.phone, o.bill_phone) is not null
           order by o.customer_id, o.placed_at desc) x
   where c.id = x.customer_id and c.order_phone is distinct from x.phone;
  return null;
end $$;
revoke all on function public.abo_customer_order_phone() from public, anon, authenticated;
drop trigger if exists trg_orders_phone_ins on public.orders;
create trigger trg_orders_phone_ins after insert on public.orders referencing new table as changed
  for each statement execute function public.abo_customer_order_phone();
drop trigger if exists trg_orders_phone_upd on public.orders;
create trigger trg_orders_phone_upd after update on public.orders referencing new table as changed
  for each statement execute function public.abo_customer_order_phone();

-- ── The lists ───────────────────────────────────────────────
-- Their columns as they were, the phone worked out from all of them,
-- and two at the end the app reads but does not show: the moment to
-- order by, and the phone's digits to search by ("98765 43210" finds
-- "+91 98765-43210").
create or replace view public.store_orders with (security_invoker = true) as
SELECT o.id,
    o.store_id,
    o.order_number,
    to_char((o.placed_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS placed_at,
    c.name AS customer_name,
    COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone) AS customer_phone,
    o.total,
    o.total_original,
    o.currency,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'Cancelled'::text
            ELSE o.financial_status
        END AS status,
    o.fulfilment_status,
    o.financial_status,
    o.cancelled_at,
    NULLIF(array_to_string(o.tags, ', '::text), ''::text) AS tags,
    o.gateway,
    NULLIF(array_to_string(o.discount_codes, ', '::text), ''::text) AS discount_codes,
    o.ship_city,
    o.ship_state,
    o.ship_country,
    o.subtotal,
    o.tax,
    o.shipping,
    o.discount,
    o.external_id AS shopify_id,
    o.placed_at AS placed_ts,
    regexp_replace(COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store,
            s.timezone AS zone
           FROM stores s) zone_st ON zone_st.zone_store = o.store_id;

create or replace view public.store_customers with (security_invoker = true) as
SELECT id,
    store_id,
    name,
    COALESCE(NULLIF(phone, ''::text), order_phone) AS phone,
    email,
    city,
    orders_count,
    total_spent,
    external_id AS shopify_id,
    regexp_replace(COALESCE(NULLIF(phone, ''::text), order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits
   FROM customers;

-- ── The webhook's order, with its phones ────────────────────
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
    subtotal, tax, shipping, discount,
    phone, ship_phone, bill_phone
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
    nullif(coalesce(p_order->>'current_total_discounts', p_order->>'total_discounts'), '')::numeric,
    -- The order's own phones (0166): the one typed at checkout and the
    -- delivery's, which is where a COD buyer in India gives theirs.
    nullif(btrim(p_order->>'phone'), ''),
    nullif(btrim(p_order#>>'{shipping_address,phone}'), ''),
    nullif(btrim(p_order#>>'{billing_address,phone}'), '')
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
    discount          = coalesce(excluded.discount, public.orders.discount),
    phone             = coalesce(excluded.phone, public.orders.phone),
    ship_phone        = coalesce(excluded.ship_phone, public.orders.ship_phone),
    bill_phone        = coalesce(excluded.bill_phone, public.orders.bill_phone)
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
end $function$;

NOTIFY pgrst, 'reload schema';
