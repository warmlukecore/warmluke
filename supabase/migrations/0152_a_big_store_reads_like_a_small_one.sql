-- Migration 0152: a big store reads like a small one
--
-- Every store table let a person read a row through
-- abo_store_readable(store_id) and change it through
-- abo_store_owned(store_id): security definer calls with a query and
-- another call inside, made once for every row. A store of 652
-- customers never noticed. One of 90,692 asked for a page of its
-- customers and was stopped by the 8-second limit: on a copy, counting
-- them took 11.4 s and the first 200 took 11.9 s.
--
-- The same question, asked once a statement instead of once a row:
-- which stores this person may read, and which they own, as two sets,
-- each row looked up in the set. The answers are the ones
-- abo_can_open_store and abo_owns give, written as sets. The policies
-- move to authenticated: anon was only ever answered no by them, and
-- the workers read through their own ticket policies, which stay.

create or replace function public.abo_readable_stores() returns setof uuid
language sql stable security definer set search_path = public as $$
  select st.id from public.stores st
   where st.project_id in (select p.id from public.projects p where p.owner_id = auth.uid())
      or st.project_id in (select m.project_id from public.project_members m
                            where m.user_id = auth.uid() and m.can_see_store);
$$;

create or replace function public.abo_owned_stores() returns setof uuid
language sql stable security definer set search_path = public as $$
  select st.id from public.stores st
    join public.projects p on p.id = st.project_id
   where p.owner_id = auth.uid();
$$;

revoke all on function public.abo_readable_stores() from public, anon;
revoke all on function public.abo_owned_stores() from public, anon;
grant execute on function public.abo_readable_stores() to authenticated;
grant execute on function public.abo_owned_stores() to authenticated;

do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and qual = 'abo_store_readable(store_id)'
  loop
    execute format(
      'alter policy %I on public.%I to authenticated
         using (store_id in (select public.abo_readable_stores()))', r.policyname, r.tablename);
  end loop;
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and qual = 'abo_store_owned(store_id)'
  loop
    execute format(
      'alter policy %I on public.%I to authenticated
         using (store_id in (select public.abo_owned_stores()))
         with check (store_id in (select public.abo_owned_stores()))', r.policyname, r.tablename);
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';
