-- Migration 0028: a token given to somebody's AI may read, not write.
--
-- The consent screen says "It cannot change anything". That was not
-- true. Supabase's OAuth server issues a normal user session token —
-- its own documentation says so: "All OAuth access tokens have full
-- access to user data (same as regular session tokens), with the
-- addition of the client_id claim."
--
-- So a client never had to go through /api/mcp at all. With that token
-- it could call the database directly and delete a merchant's project.
-- Building the MCP server read-only was a door in a missing wall.
--
-- The claim is the wall. A token issued to a third-party client
-- carries client_id; one from signing in to the app does not. Every
-- table gets a restrictive policy — restrictive because it ANDs with
-- the existing ones rather than adding another way in — refusing
-- insert, update and delete when that claim is present.
--
-- Reads are untouched: reading the store is the whole point.
--
-- Anything an assistant should eventually be able to change goes
-- through a security definer function that decides for itself, which
-- is the only place such a decision can be made once rather than once
-- per table.

create or replace function public.abo_is_oauth_client()
returns boolean
language sql stable as $$
  select nullif(auth.jwt() ->> 'client_id', '') is not null
$$;

grant execute on function public.abo_is_oauth_client() to anon, authenticated;

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not like 'pg_%'
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "%s_oauth_no_insert" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_insert" on public.%I
         as restrictive for insert
         with check (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_update" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_update" on public.%I
         as restrictive for update
         using (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_delete" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_delete" on public.%I
         as restrictive for delete
         using (not public.abo_is_oauth_client())', t, t);
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';
