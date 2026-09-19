-- Migration 0084: who buys most, and what sells.
--
-- "Who is my top buyer?", "what are my best sellers?", "how many
-- repeat customers do I have?" — the three questions merchants ask
-- first, and the three the engine could not answer. Not for want of a
-- ranking operator: a section over the store reads at most a page of
-- rows in a fixed order, so anything ranked over that page is ranked
-- over the wrong rows. The answer is data in the right place, not a
-- new kind of stat.
--
-- Two things:
--
--   customers.total_spent — Shopify's own lifetime figure for the
--   customer, brought in beside orders_count. "Top buyers" is then
--   the customers list sorted by it, over every customer, and "repeat
--   customers" is a count where orders_count >= 2.
--
--   product_sales — a view, one row per product: units, revenue,
--   orders and when it last sold, from paid, uncancelled orders. It
--   is a store table like the other four, so "best sellers" is a
--   section over it, sorted by units, with every filter and stat the
--   others have. security_invoker: the reader's own rights on orders
--   and line items decide what it sees, exactly as they do elsewhere.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES, storeLeaders),
-- src/lib/shopify-import.ts and shopify-bulk.ts (total_spent), the
-- webhook dispatcher in 0060 (abo_shopify_upsert_customer).

alter table public.customers
  add column if not exists total_spent numeric(12,2);
comment on column public.customers.total_spent is
  'Lifetime spend as Shopify reports it (amountSpent). Null until the customer is next synced.';

-- The webhook road: REST sends total_spent as a string.
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
    store_id, external_id, name, email, phone, city, postal_code, tags, orders_count, total_spent, updated_at
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
    -- A payload without the figure leaves the one we have; a payload
    -- with it is Shopify's newer number.
    nullif(p_customer->>'total_spent', '')::numeric,
    coalesce((nullif(p_customer->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update
    set name = excluded.name, email = excluded.email, phone = excluded.phone,
        city = excluded.city, postal_code = excluded.postal_code, tags = excluded.tags,
        orders_count = excluded.orders_count,
        total_spent = coalesce(excluded.total_spent, public.customers.total_spent),
        updated_at = excluded.updated_at;

  return 1;
end $function$
;

-- One row per product sold. Grouped by product when the line still
-- points at one, by the title it was sold under when it does not (a
-- product deleted from Shopify since). The id is derived so a renderer
-- keying rows on it sees the same row across reads.
--
-- ponytail: computed on every read. Fine to tens of thousands of line
-- items; materialise and refresh from the importer past that.
create or replace view public.product_sales
with (security_invoker = true) as
select
  md5(li.store_id::text || ':' || coalesce(li.product_id::text, li.title, ''))::uuid as id,
  li.store_id,
  li.product_id,
  coalesce(max(p.title), max(li.title)) as title,
  sum(li.quantity)::integer as units,
  sum(li.quantity * coalesce(li.price, 0))::numeric(12,2) as revenue,
  count(distinct li.order_id)::integer as orders,
  max(o.placed_at) as last_sold,
  -- A shop sells in one currency; the rare one that does not gets the
  -- alphabetically last, and the revenue column says so if asked.
  max(o.currency) as currency
from public.order_line_items li
join public.orders o on o.id = li.order_id
left join public.products p on p.id = li.product_id
where o.financial_status = 'PAID'
  and o.cancelled_at is null
group by li.store_id, li.product_id, coalesce(li.product_id::text, li.title, '');

grant select on public.product_sales to authenticated;

NOTIFY pgrst, 'reload schema';
