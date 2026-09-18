-- Migration 0080: one meaning of "total", on both roads.
--
-- An order reaches Warmluke two ways. The import took GraphQL's
-- totalPriceSet — what the order came to when it was placed. The
-- webhook took REST's current_total_price — what it comes to today,
-- after refunds. Both were written to orders.total. So a refunded
-- order carried the original amount until a webhook touched it, the
-- refunded amount after, and the original again after the next
-- import: a number that depended on which road the order last took,
-- and a revenue stat that never matched a payout.
--
-- Now: total is what the order comes to today, on both roads, and
-- total_original is what it came to when placed. Nothing is zeroed
-- and nothing is dropped — a cancelled order keeps both; a stat that
-- wants revenue filters on financial_status, which the columns beside
-- these have always said.
--
-- Backfill: total_original = total for every row. For rows the import
-- wrote that is exactly right; for rows a webhook wrote it is the
-- refunded amount, and the next import or webhook corrects it. The
-- rows themselves cannot say which road wrote them.
--
-- Callers: src/lib/shopify-import.ts (saveOrders), the webhook route
-- through abo_shopify_webhook.

alter table public.orders add column if not exists total_original numeric;
update public.orders set total_original = total where total_original is null;

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
    store_id, external_id, order_number, customer_id, placed_at, total, total_original, currency,
    financial_status, fulfilment_status, cancelled_at, tags, source, updated_at
  ) values (
    v_store, v_ext, p_order->>'name', v_customer,
    (nullif(p_order->>'created_at', ''))::timestamptz,
    -- What the order comes to today, after refunds — Shopify's own
    -- "current" — and what it came to when placed. The import used to
    -- store the second under the first's name, so the same order
    -- carried a different total depending on which road it last took.
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

NOTIFY pgrst, 'reload schema';
