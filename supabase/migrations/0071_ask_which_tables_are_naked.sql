-- Migration 0071: a way to ask which tables are still outside the wall.
--
-- 0070 closed six tables created after 0028 built the lockdown, and
-- said the next one would arrive naked in the same way. This is what
-- lets a check notice: one function, listing any table in public that
-- does not carry all three of the restrictive policies refusing writes
-- from a token with client_id.
--
-- Granted to nobody but the service role. It names which doors are
-- open, which is a sentence that belongs in our checks and nowhere a
-- client can read it.
--
-- Callers: scripts/check-rls.mjs.

create or replace function public.abo_tables_missing_oauth_guard()
returns table (tablename text)
language sql security definer set search_path = public, pg_catalog as $$
  select t.tablename::text
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename not like 'pg_%'
     and (
       select count(*)
         from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = t.tablename
          and p.permissive = 'RESTRICTIVE'
          and p.policyname like '%oauth_no%'
     ) < 3
   order by 1
$$;

revoke all on function public.abo_tables_missing_oauth_guard() from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
