-- Migration 0091: refunds and variant titles arrive by webhook too.
--
-- An order reaches Warmluke by two roads. The import road wrote each
-- line's variant title and one refunds row per refund. The webhook
-- road wrote the lines without their variant title, and no refunds at
-- all — yet a refund is exactly what raises orders/updated, and that
-- payload carries every refund the order has. So the refunds list went
-- stale on the one event it exists for, and stayed so until the next
-- full import.
--
-- Now both roads write the same rows. A refund's amount is what was
-- actually given back — the successful refund transactions, shipping
-- included, which is the number GraphQL calls totalRefundedSet — and
-- its quantity is how many units went back. Upserted on the Shopify
-- id, the way the import writes them, so the two roads land on one
-- row. Never deleted here: a payload without `refunds` is a partial
-- payload, not an order with no refunds.
--
-- Callers: the webhook route through abo_shopify_webhook; the import
-- writes the same columns from src/lib/shopify-import.ts (saveOrders).

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
    store_id, external_id, order_number, customer_id, placed_at, total, total_original, currency,
    financial_status, fulfilment_status, cancelled_at, tags, source, updated_at
  ) values (
    v_store, v_ext, p_order->>'name', v_customer,
    (nullif(p_order->>'created_at', ''))::timestamptz,
    -- What the order comes to today, after refunds — Shopify's own
    -- "current" — and what it came to when placed.
    nullif(coalesce(p_order->>'current_total_price', p_order->>'total_price'), '')::numeric,
    nullif(coalesce(p_order->>'total_price', p_order->>'current_total_price'), '')::numeric,
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
    total_original    = coalesce(excluded.total_original, public.orders.total_original),
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

  -- Refunds ride inside the order on this road too.
  for v_refund in select * from jsonb_array_elements(coalesce(p_order->'refunds', '[]'::jsonb))
  loop
    if public.abo_shopify_gid('Refund', v_refund->>'id') is null then continue; end if;
    insert into public.refunds (store_id, order_id, external_id, amount, quantity, refunded_at)
    values (
      v_store, v_order,
      public.abo_shopify_gid('Refund', v_refund->>'id'),
      -- The successful refund transactions; failing that, the lines'
      -- subtotals; failing that, nothing was given back.
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

  -- The copy is current as of now, which is what the assistant reports.
  update public.stores set last_synced_at = now() where id = v_store;

  return v_lines;
end $function$
;

NOTIFY pgrst, 'reload schema';
