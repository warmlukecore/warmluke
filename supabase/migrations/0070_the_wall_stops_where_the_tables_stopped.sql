-- Migration 0070: the wall was built once, and the house kept growing.
--
-- 0028 refused every write from a token carrying client_id — a token
-- issued to somebody's AI rather than to somebody signing in. It did
-- that by looping over every table in public and adding three
-- restrictive policies to each.
--
-- Every table created since then has none of them. Six now:
--
--   build_requests       — the dangerous one. A client could UPDATE its
--                          own row and write approved_at itself, which
--                          is the whole of the gate 0047 added. "A
--                          build needs a yes" was true only for clients
--                          that chose to ask.
--   app_secrets          — the Shopify client secret lives here.
--   mcp_calls            — the record its own rate limit counts.
--   fx_rates             — what every imported amount is shown as.
--   shopify_redactions   — the list of people who asked to be forgotten.
--   landing_events       — anyone may insert by design; the point here
--                          is that nobody may UPDATE or DELETE.
--
-- Re-running the loop closes today. It does not close tomorrow: the
-- next table added will arrive naked in exactly the same way, and
-- nothing will say so. So check-rls now asserts that every table in
-- public carries all three, which turns the next occurrence from a
-- silent hole into a failed check.
--
-- ponytail: a loop plus a check, not an event trigger. A DDL trigger
-- would be self-maintaining but needs rights this database does not
-- hand out, and a check that fails loudly is worth more than a
-- mechanism nobody can install.
--
-- Callers: src/app/api/mcp/route.ts, src/lib/apply.ts, src/app/api/fx/route.ts.

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not like 'pg_%'
  loop
    execute format('alter table public.%I enable row level security', t);

    -- Restrictive, so they AND with whatever else is on the table
    -- rather than offering another way in.
    execute format('drop policy if exists "%s_oauth_no_insert" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_insert" on public.%I as restrictive
         for insert to authenticated
         with check (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_update" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_update" on public.%I as restrictive
         for update to authenticated
         using (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_delete" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_delete" on public.%I as restrictive
         for delete to authenticated
         using (not public.abo_is_oauth_client())', t, t);
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';
