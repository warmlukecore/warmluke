-- Migration 0040: the indexes a big store will need.
--
-- Seven foreign keys had no index on the referencing column. On this
-- dev store, with twenty products, none of it is measurable — which
-- is exactly why it would have shipped. On a store with a million
-- order lines, each of these is a sequential scan of the largest
-- table in the database, and the first anyone hears about it is a
-- page that stops loading.
--
-- Only the ones that grow with the store are added. An index is not
-- free: every insert maintains it, and the importer's whole job is
-- inserting. build_requests.requested_by is left alone — one row per
-- request a person typed, and it will never be large.
--
-- Callers: none. The query planner uses these.

-- The biggest table there will ever be. "What else did people buy
-- with this?" and "which orders contain this variant?" both scan it
-- end to end without these.
create index if not exists idx_order_line_items_variant
  on public.order_line_items(variant_id);
create index if not exists idx_order_line_items_product
  on public.order_line_items(product_id);

-- One row per variant per location, and the join low_stock makes.
create index if not exists idx_inventory_levels_variant
  on public.inventory_levels(variant_id);

-- Deleting or re-importing a product touches every variant under it.
create index if not exists idx_variants_product
  on public.variants(product_id);

create index if not exists idx_refunds_store
  on public.refunds(store_id);

-- Not about size — about how often. Every row-level security check in
-- the app resolves ownership through this column, so it is read far
-- more than anything else here.
create index if not exists idx_projects_owner
  on public.projects(owner_id);
