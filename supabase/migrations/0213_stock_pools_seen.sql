-- Migration 0213: stock pools, seen (docs/domain/stock-by-sku.md, phase 1)
--
-- Shopify counts stock per listing whatever the SKU says, so one case
-- listed twice can show 72 here and 168 there, and a printed design that
-- is made from a blank shows only its own few. Phase 1 shows it, writes
-- nothing: a store list, read by sections, Luke and the owner's AI like
-- any other.
--
-- One row per SKU and location that is pooled: listed more than once,
-- made from a blank, or a blank with designs on it. Its listings, the
-- count a pool would start from (the lowest of them: never more than
-- every listing has, decided 12 Oct) and how far apart they are, the
-- blank's count, and what could be sold: own plus the blank's, for a
-- design (decided 12 Oct).
--
-- A blank is read from what the owner already keeps: any field of their
-- own on a stock row whose value is another SKU of the same store is that
-- row's blank, whatever the field is called (Carefone's "Parent SKU" is
-- one). No new table and nothing to fill in; phase 3 turns these into
-- links of their own, with the owner's OK.
--
-- Worked out by abo_stock_pools(store), one store at a time: a view that
-- left-joined the links found no store to narrow them to and read every
-- store's own fields (1.1 s for one store's page, 12 Oct). The view calls
-- it for the stores the reader may see, and a page names its store.

create or replace function public.abo_stock_pools(p_store uuid)
returns table (
  id              uuid,
  sku             text,
  role            text,
  products        text,
  location_name   text,
  listings        int,
  start_count     int,
  highest         int,
  spread          int,
  counts          text,
  draws_from      text,
  blank_available int,
  sellable        int,
  designs         int
)
language sql stable security invoker set search_path = public as $$
  with links as materialized (
    -- A SKU and the blank its own fields name, the first by name when two do.
    select x.sku, min(x.val) as blank_sku
      from (
        select v.sku, btrim(f.value) as val
          from public.stores s
          join public.modules m on m.project_id = s.project_id and m.source_table = 'inventory_levels'
          join public.records r on r.module_id = m.id and r.store_row_id is not null
          join public.inventory_levels i on i.id = r.store_row_id and i.store_id = s.id
          join public.variants v on v.id = i.variant_id
          cross join lateral jsonb_each_text(r.data) f
         where s.id = p_store
           and nullif(btrim(f.value), '') is not null
           and nullif(btrim(v.sku), '') is not null
      ) x
      join (select distinct k.sku from public.variants k where k.store_id = p_store) k on k.sku = x.val
     where x.val <> x.sku
     group by x.sku
  ),
  pools as (
    select i.location_id,
           max(nullif(i.location_name, '')) as location_name,
           v.sku,
           count(*)::int as listings,
           min(coalesce(i.available, 0))::int as lowest,
           max(coalesce(i.available, 0))::int as highest,
           left(string_agg(distinct p.title, ' · ' order by p.title), 300) as products
      from public.inventory_levels i
      join public.variants v on v.id = i.variant_id
      left join public.products p on p.id = v.product_id
     -- Untracked variants are not stock: Shopify counts nothing for them.
     where i.store_id = p_store
       and v.tracked is not false
       and nullif(btrim(v.sku), '') is not null
     group by i.location_id, v.sku
  ),
  designs as (
    select l.blank_sku, count(*)::int as designs from links l group by l.blank_sku
  )
  select md5(p_store::text || '|' || coalesce(g.location_id, '') || '|' || g.sku)::uuid,
         g.sku,
         case
           when coalesce(d.designs, 0) > 0 then 'Blank'
           when l.blank_sku is not null then 'Design'
           else 'Shared SKU'
         end,
         g.products,
         g.location_name,
         g.listings,
         g.lowest,
         g.highest,
         g.highest - g.lowest,
         case
           when g.listings < 2 then 'One listing'
           when g.highest = g.lowest then 'Same everywhere'
           else 'Disagree'
         end,
         l.blank_sku,
         b.lowest,
         g.lowest + coalesce(b.lowest, 0),
         coalesce(d.designs, 0)
    from pools g
    left join links l on l.sku = g.sku
    -- The blank's own count where the design is: where its pool would start.
    left join pools b on l.blank_sku is not null and b.sku = l.blank_sku and b.location_id is not distinct from g.location_id
    left join designs d on d.blank_sku = g.sku
   where g.listings > 1
      or l.blank_sku is not null
      or coalesce(d.designs, 0) > 0
$$;
revoke all on function public.abo_stock_pools(uuid) from public, anon;
grant execute on function public.abo_stock_pools(uuid) to authenticated;

create or replace view public.store_stock_pools with (security_invoker = true) as
select p.id, s.id as store_id, p.sku, p.role, p.products, p.location_name, p.listings, p.start_count,
       p.highest, p.spread, p.counts, p.draws_from, p.blank_available, p.sellable, p.designs
  from public.stores s
  cross join lateral public.abo_stock_pools(s.id) p;
grant select on public.store_stock_pools to authenticated;

-- 0204's mapping, one line longer: the list every reader finds by name.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'            then 'store_orders'
    when 'customers'         then 'store_customers'
    when 'products'          then 'store_products'
    when 'inventory_levels'  then 'store_inventory'
    when 'product_sales'     then 'product_sales'
    when 'order_line_items'  then 'store_order_items'
    when 'refunds'           then 'store_refunds'
    when 'variants'          then 'store_variants'
    when 'fulfillments'      then 'store_fulfillments'
    when 'transactions'      then 'store_transactions'
    when 'locations'         then 'store_locations'
    when 'collections'       then 'store_collections'
    when 'carts'             then 'store_abandoned_checkouts'
    when 'drafts'            then 'store_draft_orders'
    when 'draft_order_items' then 'store_draft_order_items'
    when 'discounts'         then 'store_discounts'
    when 'returns'           then 'store_returns'
    when 'return_reasons'    then 'return_reasons'
    when 'payouts'           then 'store_payouts'
    when 'courier_shipments' then 'store_courier_shipments'
    when 'stock_pools'       then 'store_stock_pools'
  end;
$$;

notify pgrst, 'reload schema';
