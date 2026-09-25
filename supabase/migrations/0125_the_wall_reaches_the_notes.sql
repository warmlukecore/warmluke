-- The wall reaches the notes.
--
-- 0124 made store_row_tombstones with no permissive policy and no grant,
-- reached only through its functions, but left off the wall every table
-- has whatever else it has: no write from a connected client's token.
-- Nothing could write there anyway; check-rls asks every table for the
-- wall regardless, so the next table that does need it cannot slip by.

drop policy if exists store_row_tombstones_oauth_no_insert on public.store_row_tombstones;
create policy store_row_tombstones_oauth_no_insert on public.store_row_tombstones
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists store_row_tombstones_oauth_no_update on public.store_row_tombstones;
create policy store_row_tombstones_oauth_no_update on public.store_row_tombstones
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists store_row_tombstones_oauth_no_delete on public.store_row_tombstones;
create policy store_row_tombstones_oauth_no_delete on public.store_row_tombstones
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());
