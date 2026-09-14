-- The unique index on inventory_levels was written over an expression,
-- coalesce(location_name, ''). Postgres only matches an ON CONFLICT target
-- to an expression index if the conflict clause repeats the same
-- expression, and PostgREST sends plain column names — so every inventory
-- upsert failed with "no unique or exclusion constraint matching".
--
-- The coalesce was only ever standing in for a null, so remove the null
-- instead and index the columns themselves. A level with no variant is not
-- a level we can use, so that column is required too.

delete from public.inventory_levels where variant_id is null;

update public.inventory_levels set location_name = '' where location_name is null;

alter table public.inventory_levels
  alter column location_name set default '',
  alter column location_name set not null,
  alter column variant_id set not null;

drop index if exists public.idx_inventory_unique;

create unique index if not exists idx_inventory_unique
  on public.inventory_levels(store_id, variant_id, location_name);

NOTIFY pgrst, 'reload schema';
