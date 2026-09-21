-- Migration 0093: the wall reaches the shipments.
--
-- 0092 added a table, and check-rls said so before anybody else could:
-- a table without the three restrictive policies is one a connected
-- assistant's token can write to. Shipments are Shopify's to write and
-- the import's to copy; a client that can read them must not be able
-- to invent one.
--
-- Callers: none directly — abo_tables_missing_oauth_guard (0071) is
-- what notices, and check-rls is what asks it.

drop policy if exists "fulfillments_oauth_no_insert" on public.fulfillments;
create policy "fulfillments_oauth_no_insert"
  on public.fulfillments as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "fulfillments_oauth_no_update" on public.fulfillments;
create policy "fulfillments_oauth_no_update"
  on public.fulfillments as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "fulfillments_oauth_no_delete" on public.fulfillments;
create policy "fulfillments_oauth_no_delete"
  on public.fulfillments as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

NOTIFY pgrst, 'reload schema';
