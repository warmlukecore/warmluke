-- A change asked for appears where the merchant waits for it.
--
-- The chat panel has listened for store_actions since 0107, so that a
-- change their own assistant asked for (and now Luke) turns up on the
-- card under the conversation the moment it is asked. The table was
-- never added to the realtime publication, so nothing ever arrived: the
-- request sat unseen until the page was loaded again. build_requests,
-- the other thing the panel waits on, was added; this was missed.
--
-- Realtime applies the table's row-level security to what it sends, so
-- a merchant hears only about their own project's requests.
--
-- Guarded, because adding a table the publication already holds is an
-- error, and a database somebody fixed by hand must not refuse this.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'store_actions'
  ) then
    alter publication supabase_realtime add table public.store_actions;
  end if;
end $$;
