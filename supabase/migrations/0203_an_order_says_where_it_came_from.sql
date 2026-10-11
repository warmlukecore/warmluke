-- Migration 0203: an order says where it came from
--
-- Connectors, phase 1 (docs/integrations/connectors.md, 11 Oct). Before
-- any ad account is connected, the store already knows half of what an
-- ad was worth: which visit each order came from. Shopify keeps it as
-- the order's customer journey (its last visit: the source, the UTM
-- parameters, the landing page, the referrer) and its sales channel.
-- read_orders already holds it; nothing new is asked of the merchant.
--
-- - orders.channel        Shopify's sourceName: web, pos, an app's name.
-- - orders.visit_source   where the last visit came from, as Shopify
--                         names it: Facebook, Google, direct, a site.
-- - orders.utm_source / utm_medium / utm_campaign
-- - orders.landing_page, orders.referrer
--
-- Two roads, as for every order field. The import reads the journey
-- (lib/shopify-import); the webhook's payload has no journey, so it
-- reads the landing URL's utm_ parameters, the referring site and the
-- source name. Shopify fills the journey a little after the order, so a
-- road that does not carry these must not erase what the other wrote:
-- a trigger keeps them. Empty means not known yet, never "direct".

alter table public.orders
  add column if not exists channel      text,
  add column if not exists visit_source text,
  add column if not exists utm_source   text,
  add column if not exists utm_medium   text,
  add column if not exists utm_campaign text,
  add column if not exists landing_page text,
  add column if not exists referrer     text;

-- One query parameter of a URL, decoded ("summer%20sale" is "summer sale").
-- An encoding that does not decode stays as it came.
create or replace function public.abo_url_param(p_url text, p_key text)
returns text language plpgsql immutable set search_path = public as $$
declare v text;
begin
  v := substring(p_url from '[?&]' || p_key || '=([^&#]*)');
  if v is null or v = '' then return null; end if;
  v := replace(v, '+', ' ');
  begin
    select convert_from(
             string_agg(case when m[1] is not null then decode(m[1], 'hex') else convert_to(m[2], 'UTF8') end,
                        ''::bytea order by n),
             'UTF8')
      into v
      from regexp_matches(v, '%([0-9A-Fa-f]{2})|([^%]+|%)', 'g') with ordinality as r(m, n);
  exception when others then
    null;
  end;
  return nullif(btrim(left(v, 200)), '');
end $$;

-- Known stays known: a road without them leaves them as they were; a URL
-- is kept to a length a list can show.
create or replace function public.abo_order_keeps_its_source() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.channel      := coalesce(new.channel, old.channel);
    new.visit_source := coalesce(new.visit_source, old.visit_source);
    new.utm_source   := coalesce(new.utm_source, old.utm_source);
    new.utm_medium   := coalesce(new.utm_medium, old.utm_medium);
    new.utm_campaign := coalesce(new.utm_campaign, old.utm_campaign);
    new.landing_page := coalesce(new.landing_page, old.landing_page);
    new.referrer     := coalesce(new.referrer, old.referrer);
  end if;
  new.landing_page := left(nullif(btrim(new.landing_page), ''), 500);
  new.referrer     := left(nullif(btrim(new.referrer), ''), 500);
  new.utm_source   := left(nullif(btrim(new.utm_source), ''), 200);
  new.utm_medium   := left(nullif(btrim(new.utm_medium), ''), 200);
  new.utm_campaign := left(nullif(btrim(new.utm_campaign), ''), 200);
  new.visit_source := left(nullif(btrim(new.visit_source), ''), 200);
  new.channel      := left(nullif(btrim(new.channel), ''), 100);
  return new;
end $$;
drop trigger if exists abo_order_keeps_its_source on public.orders;
create trigger abo_order_keeps_its_source
  before insert or update on public.orders
  for each row execute function public.abo_order_keeps_its_source();

-- ── The webhook's order, with where it came from ────────────
-- 0166's body, with the seven columns read from the payload.
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
  v_landing  text := nullif(p_order->>'landing_site', '');
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
    phone, ship_phone, bill_phone,
    channel, utm_source, utm_medium, utm_campaign, landing_page, referrer
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
    nullif(btrim(p_order#>>'{billing_address,phone}'), ''),
    -- Where it came from (0203): the payload has no journey, so the
    -- landing URL's own utm_ parameters, the referring site, the channel.
    nullif(p_order->>'source_name', ''),
    public.abo_url_param(v_landing, 'utm_source'),
    public.abo_url_param(v_landing, 'utm_medium'),
    public.abo_url_param(v_landing, 'utm_campaign'),
    v_landing,
    nullif(p_order->>'referring_site', '')
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
    bill_phone        = coalesce(excluded.bill_phone, public.orders.bill_phone),
    -- Kept when silent by the trigger above, as every road's are.
    channel           = excluded.channel,
    utm_source        = excluded.utm_source,
    utm_medium        = excluded.utm_medium,
    utm_campaign      = excluded.utm_campaign,
    landing_page      = excluded.landing_page,
    referrer          = excluded.referrer
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

-- ── The list, with where each order came from ───────────────
-- 0193's view, the seven columns after its own (a view grows at its end).
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
    regexp_replace(COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits,
    NULLIF(lower(btrim(c.email)), ''::text) AS customer_email,
    o.shipment_status,
    o.shipment_carrier AS carrier,
    o.shipment_tracking AS tracking_number,
    to_char((o.shipment_shipped_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS shipped_at,
    to_char((o.shipment_delivered_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS delivered_at,
    o.shipments,
    o.refunded,
    o.channel,
    o.visit_source,
    o.utm_source,
    o.utm_medium,
    o.utm_campaign,
    o.landing_page,
    o.referrer
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store,
            s.timezone AS zone
           FROM stores s) zone_st ON zone_st.zone_store = o.store_id;

-- ── A figure by where orders came from ──────────────────────
-- 0140's store metrics, with two more ways to split and to filter:
-- source (the last visit's, as Shopify names it) and campaign (its UTM
-- campaign). Orders whose visit is not known group under "—".
create or replace function public.abo_store_metrics(
  p_store   uuid,
  p_measure text,
  p_by      text  default 'none',
  p_from    date  default null,
  p_to      date  default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_tz       text;
  v_currency text;
  v_from     timestamptz;
  v_to       timestamptz;
  v_where    text;
  v_join     text := '';
  v_key      text;
  v_val      text;
  v_order    text;
  v_groups   jsonb;
  v_total    jsonb;
  v_limit    constant int := 200;
  f          record;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select s.project_id, coalesce(s.timezone, 'UTC'), s.currency
    into v_project, v_tz, v_currency
    from public.stores s where s.id = p_store;
  if v_project is null or not public.abo_can_open_store(v_project) then
    raise exception 'No such store on this account.' using errcode = '42501';
  end if;
  if p_measure not in ('orders', 'revenue', 'units', 'aov', 'customers', 'new_customers') then
    raise exception 'Not a measure: %', p_measure using errcode = '22023';
  end if;
  if p_by not in ('none', 'day', 'week', 'month', 'product', 'city', 'state', 'gateway', 'status', 'fulfilment', 'customer', 'source', 'campaign') then
    raise exception 'Not a dimension: %', p_by using errcode = '22023';
  end if;
  perform set_config('statement_timeout', '5000', true);

  -- The window, in the store's own day: from the start of p_from to the end of p_to.
  if p_from is not null then v_from := (p_from::timestamp) at time zone v_tz; end if;
  if p_to   is not null then v_to   := ((p_to + 1)::timestamp) at time zone v_tz; end if;
  if v_from is not null and v_to is not null and v_to <= v_from then
    raise exception 'The window ends before it starts.' using errcode = '22023';
  end if;

  -- The rows: this store's orders, in the window, not cancelled unless asked.
  v_where := format('o.store_id = %L', p_store);
  if v_from is not null then v_where := v_where || format(' and o.placed_at >= %L', v_from); end if;
  if v_to   is not null then v_where := v_where || format(' and o.placed_at < %L', v_to); end if;
  if not coalesce((p_filters->>'include_cancelled')::boolean, false) then
    v_where := v_where || ' and o.cancelled_at is null';
  end if;
  for f in
    select key, value from jsonb_each_text(coalesce(p_filters, '{}'::jsonb))
     where key in ('status', 'gateway', 'fulfilment', 'city', 'state', 'source', 'campaign') and btrim(value) <> ''
  loop
    v_where := v_where || format(' and %s = %L',
      case f.key
        when 'status'     then 'o.financial_status'
        when 'gateway'    then 'o.gateway'
        when 'fulfilment' then 'o.fulfilment_status'
        when 'city'       then 'o.ship_city'
        when 'state'      then 'o.ship_state'
        when 'source'     then 'o.visit_source'
        when 'campaign'   then 'o.utm_campaign'
      end, f.value);
  end loop;
  if btrim(coalesce(p_filters->>'product', '')) <> '' then
    v_where := v_where || format(
      ' and exists (select 1 from public.order_line_items lf left join public.products pf on pf.id = lf.product_id where lf.order_id = o.id and coalesce(pf.title, lf.title) ilike %L)',
      '%' || (p_filters->>'product') || '%');
  end if;

  -- What each row is grouped under.
  v_key := case p_by
    when 'none'       then '''all'''
    when 'day'        then format('to_char(o.placed_at at time zone %L, ''YYYY-MM-DD'')', v_tz)
    when 'week'       then format('to_char(date_trunc(''week'', o.placed_at at time zone %L), ''YYYY-MM-DD'')', v_tz)
    when 'month'      then format('to_char(o.placed_at at time zone %L, ''YYYY-MM'')', v_tz)
    when 'city'       then 'coalesce(o.ship_city, ''—'')'
    when 'state'      then 'coalesce(o.ship_state, ''—'')'
    when 'gateway'    then 'coalesce(o.gateway, ''—'')'
    when 'status'     then 'case when o.cancelled_at is not null then ''Cancelled'' else coalesce(o.financial_status, ''—'') end'
    when 'fulfilment' then 'coalesce(o.fulfilment_status, ''—'')'
    when 'product'    then 'coalesce(p.title, li.title, ''—'')'
    when 'customer'   then 'coalesce(c.name, c.email, ''no name'')'
    when 'source'     then 'coalesce(o.visit_source, ''—'')'
    when 'campaign'   then 'coalesce(o.utm_campaign, ''—'')'
  end;

  -- Lines are joined only when the figure is per line (units, or
  -- anything by product): an order spans products, and money summed
  -- over its lines is the only revenue a product can be said to have.
  if p_by = 'product' or p_measure = 'units' then
    v_join := ' join public.order_line_items li on li.order_id = o.id left join public.products p on p.id = li.product_id';
  end if;
  if p_by = 'customer' then
    v_join := v_join || ' left join public.customers c on c.id = o.customer_id';
  end if;

  v_val := case p_measure
    when 'orders'    then 'count(distinct o.id)'
    when 'units'     then 'coalesce(sum(li.quantity), 0)'
    when 'customers' then 'count(distinct o.customer_id)'
    -- A customer is new in the window when this is their first order in the shop.
    when 'new_customers' then 'count(distinct o.customer_id) filter (where o.placed_at = (select min(o2.placed_at) from public.orders o2 where o2.store_id = o.store_id and o2.customer_id = o.customer_id and o2.cancelled_at is null))'
    when 'revenue'   then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0)' else 'coalesce(sum(o.total), 0)' end
    when 'aov'       then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0) / greatest(count(distinct o.id), 1)' else 'avg(o.total)' end
  end;
  -- Time reads in order; everything else biggest first.
  v_order := case when p_by in ('day', 'week', 'month') then 'k' else 'v desc nulls last, n desc, k' end;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''key'', k, ''value'', v, ''orders'', n) order by %s), ''[]''::jsonb)
       from (select %s as k, %s as v, count(distinct o.id) as n
               from public.orders o%s where %s group by 1 order by %s limit %s) g',
    v_order, v_key, v_val, v_join, v_where, v_order, v_limit + 1)
    into v_groups;
  execute format(
    'select jsonb_build_object(''value'', %s, ''orders'', count(distinct o.id)) from public.orders o%s where %s',
    v_val, v_join, v_where)
    into v_total;

  return jsonb_build_object(
    'measure', p_measure, 'by', p_by,
    'from', p_from, 'to', p_to, 'timezone', v_tz, 'currency', v_currency,
    'cancelled_included', coalesce((p_filters->>'include_cancelled')::boolean, false),
    'total', v_total,
    'groups', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_groups) e limit v_limit) x),
    'truncated', jsonb_array_length(v_groups) > v_limit
  );
end $$;

notify pgrst, 'reload schema';
