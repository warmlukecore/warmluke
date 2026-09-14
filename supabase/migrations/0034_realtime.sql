-- Migration 0034: the app hears about changes it did not make.
--
-- A merchant approves something in Claude and it is built — but the
-- browser is still showing what it loaded when the page opened, so
-- nothing appears until they refresh. Worse, nothing tells them to
-- refresh, so the stale screen looks just as real as a fresh one.
--
-- Four tables, chosen by what a build actually touches: the sections
-- list, the open section's columns and rows, and the requests strip.
-- Nothing else is published — the store tables hold tens of thousands
-- of rows an import writes in bursts, and streaming those to every
-- open tab would be a flood nobody reads.

do $$
begin
  -- alter publication has no "if not exists"; adding a table twice is
  -- an error, and this file should be safe to re-run.
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'modules') then
    alter publication supabase_realtime add table public.modules;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'ui_schemas') then
    alter publication supabase_realtime add table public.ui_schemas;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'records') then
    alter publication supabase_realtime add table public.records;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'build_requests') then
    alter publication supabase_realtime add table public.build_requests;
  end if;
end $$;

-- A removed row arrives carrying only its primary key unless the table
-- says otherwise, and a subscription filtered on project_id would
-- never match it — so a section taken away in another tab would sit
-- there looking real. These three are small; full identity costs
-- little.
alter table public.modules        replica identity full;
alter table public.ui_schemas     replica identity full;
alter table public.build_requests replica identity full;
-- records is left on its primary key: it is the one that grows, and a
-- row removed elsewhere is a smaller wrong than every row update
-- carrying its old copy through the WAL.
