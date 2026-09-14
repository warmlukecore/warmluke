-- Migration 0025: a section can show the store's own rows.
--
-- Until now every section held rows the merchant typed, in `records`.
-- That left this project with two Orders: four they typed and four that
-- came from Shopify, with different numbers and different names and no
-- relationship between them.
--
-- A section with source_table set shows the Shopify rows instead. It is
-- read-only in the app: the import owns those rows, and an edit here
-- would be silently overwritten the next time it ran.
--
-- The allowed values are a constraint rather than an app-side check.
-- This column names a table that then gets queried, so the database is
-- the only place worth enforcing it — nothing outside this list can be
-- stored, whatever any caller believes.

alter table public.modules
  add column if not exists source_table text;

alter table public.modules
  drop constraint if exists modules_source_table_allowed;

alter table public.modules
  add constraint modules_source_table_allowed
  check (
    source_table is null
    or source_table in ('orders', 'customers', 'products', 'inventory_levels')
  );

NOTIFY pgrst, 'reload schema';
