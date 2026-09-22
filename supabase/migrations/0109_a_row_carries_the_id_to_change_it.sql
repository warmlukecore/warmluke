-- Migration 0109: a row you can change carries the id to change it.
--
-- The stock list answers "what is running low" and hands back a
-- product, a variant, an SKU and four numbers. Everything a person
-- needs, and nothing a change needs: setting a count takes an
-- inventory item and a location, by Shopify's own ids, and neither
-- was in the view. So an assistant could see that something was out
-- of stock and had no way to say which thing to correct.
--
-- Both are already in our tables, as full gids. They were simply
-- never carried through.
--
-- Rebuilt from 0097, the newest definition of this view.
--
-- Callers: src/lib/store-read.ts (view: "store_inventory").

create or replace view public.store_inventory with (security_invoker = true) as
select
  i.id,
  i.store_id,
  p.title as product,
  v.title as variant,
  v.sku,
  nullif(i.location_name, '') as location_name,
  i.available,
  i.on_hand,
  i.committed,
  i.incoming,
  -- Said plainly, because "0 available, 12 on hand" is a sentence a
  -- merchant has to work out and this is the answer to it.
  case
    when v.tracked is false                      then 'Not tracked'
    when coalesce(i.on_hand, 0) > 0
     and coalesce(i.available, 0) <= 0           then 'All promised'
    when coalesce(i.available, 0) <= 0
     and coalesce(i.incoming, 0) > 0             then 'Out, more coming'
    when coalesce(i.available, 0) <= 0           then 'Out of stock'
    else 'In stock'
  end as stock_state,
  -- The two a change is aimed at. Named exactly as Shopify names
  -- them, because they are handed back to Shopify unchanged.
  --
  -- At the end, and not where they would read best: "create or
  -- replace view" may append columns and may not insert them, so
  -- putting these beside location_name asks Postgres to rename
  -- available, which it refuses. Anything added here later goes
  -- after these, for the same reason.
  v.inventory_item_id,
  i.location_id
from public.inventory_levels i
left join public.variants v on v.id = i.variant_id
left join public.products p on p.id = v.product_id;

NOTIFY pgrst, 'reload schema';
