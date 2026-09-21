-- Migration 0097: what it cost, and what is really there.
--
-- Two things Shopify has been handing over all along, under scopes
-- this app already holds, that the import never asked for.
--
-- The cost. Every answer about money so far has been about what came
-- in. What a merchant actually wants to know is what they kept, and
-- the only missing number was the one they paid. It is per inventory
-- item, which is per variant, and it is empty until they type it into
-- Shopify — so a margin is offered where it exists and never guessed
-- where it does not.
--
-- And the rest of the stock. "Available" is not what is on the shelf:
-- it is what is on the shelf minus what is already promised to orders
-- not yet shipped. A shop can hold three hundred and be unable to
-- sell one of them, and the old copy could not tell that from being
-- empty. on_hand, committed and incoming say which it is.
--
-- Also whether Shopify tracks the variant at all. An untracked one
-- reads zero at every location, which looks exactly like sold out and
-- is not, and there was no way to tell the two apart.
--
-- The webhook road carries none of this: a product payload has no
-- cost, and inventory_levels/update carries available and nothing
-- else. So these fill on import and stay as they were between them,
-- which is honest for numbers that change when a merchant edits them
-- rather than when a customer buys.
--
-- Callers: src/lib/shopify-import.ts (saveProducts, saveInventory),
-- and the variants and inventory lists in src/lib/store-read.ts.

alter table public.variants
  -- What the merchant paid. Null means they have not said, which is
  -- not the same as zero and must never be shown as a margin.
  add column if not exists cost    numeric(12,2),
  add column if not exists tracked boolean;

alter table public.inventory_levels
  add column if not exists on_hand   integer,
  add column if not exists committed integer,
  add column if not exists incoming  integer;

comment on column public.variants.cost is
  'Unit cost from Shopify''s inventory item. Null when the merchant has not entered one; never treat as zero.';
comment on column public.inventory_levels.available is
  'What can still be sold: on_hand minus committed, as Shopify computes it.';

-- Columns are only added at the end, so the views can be replaced
-- without dropping what depends on them.
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
  end as stock_state
from public.inventory_levels i
left join public.variants v on v.id = i.variant_id
left join public.products p on p.id = v.product_id;

create or replace view public.store_variants with (security_invoker = true) as
select
  v.id,
  v.store_id,
  v.product_id,
  coalesce(p.title, '') as product,
  v.title as variant,
  v.sku,
  v.barcode,
  v.price,
  s.currency,
  v.cost,
  -- Worked out here so every reader agrees on what a margin is, and
  -- null rather than zero when the cost is unknown: a hundred per
  -- cent margin on an unpriced cost is the kind of number somebody
  -- puts in a report.
  case when v.cost is not null and v.price is not null then v.price - v.cost end as margin,
  case
    when v.cost is not null and v.price is not null and v.price > 0
    then round(((v.price - v.cost) / v.price) * 100, 1)
  end as margin_pct,
  v.tracked
from public.variants v
left join public.products p on p.id = v.product_id
join public.stores s on s.id = v.store_id;

grant select on public.store_inventory, public.store_variants to authenticated;

NOTIFY pgrst, 'reload schema';
