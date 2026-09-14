-- Migration 0026: an order that changes in Shopify changes here too.
--
-- Until now the copy was only as fresh as the last time somebody opened
-- the app, because the strip is what drives the import. An assistant
-- reading it would state yesterday's count as today's — confidently,
-- which is the worst way to be wrong.
--
-- Security definer and called with the anon key, like the compliance
-- webhooks: a webhook carries no session, and the alternative is a
-- service-role key on the server, which would bypass row-level
-- security for every other code path too.
--
-- Two shapes have to be reconciled. The importer reads GraphQL, where
-- an id is "gid://shopify/Order/123" and tags are an array. A webhook
-- is REST, where the id is 123 and tags are "cod, priority". Writing
-- the REST shape straight in would give every order a second row and
-- every tag list one long tag.

create or replace function public.abo_shopify_gid(kind text, id text)
returns text language sql immutable as $$
  select case
    when id is null or id = '' then null
    when id like 'gid://%' then id
    else 'gid://shopify/' || kind || '/' || id
  end
$$;

create or replace function public.abo_shopify_upsert_order(
  p_shop  text,
  p_order jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store    uuid;
  v_order    uuid;
  v_customer uuid;
  v_ext      text;
  v_line     jsonb;
  v_lines    integer := 0;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
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
end $$;

revoke all on function public.abo_shopify_upsert_order(text, jsonb) from public;
grant execute on function public.abo_shopify_upsert_order(text, jsonb) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
