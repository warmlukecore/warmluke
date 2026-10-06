-- What is new to each person (6 Oct). A section they have not opened since
-- it was made is marked New in their sidebar; one changed since they last
-- looked carries a dot; inside it, the columns it gained since then are
-- marked for that visit. Kept per person in the database, not the browser:
-- it follows them from the laptop to the phone, and a teammate opening a
-- section does not clear it for them.
--
-- Sections as they stood when this arrived count as seen, so a sidebar
-- does not light up whole on the day it ships.
--
-- Callers: src/components/AppShell.tsx (abo_whats_new on load, abo_seen
-- when a section is shown).

create table if not exists public.section_seen (
  user_id   uuid not null references auth.users(id) on delete cascade,
  module_id uuid not null references public.modules(id) on delete cascade,
  version   integer not null,
  seen_at   timestamptz not null default now(),
  primary key (user_id, module_id)
);
-- A section deleted takes its marks with it.
create index if not exists section_seen_module on public.section_seen (module_id);

alter table public.section_seen enable row level security;
drop policy if exists section_seen_read on public.section_seen;
create policy section_seen_read on public.section_seen
  for select to authenticated using (user_id = auth.uid());
-- No write of the table itself: abo_seen is the way in.
drop policy if exists section_seen_oauth_no_insert on public.section_seen;
create policy section_seen_oauth_no_insert on public.section_seen
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists section_seen_oauth_no_update on public.section_seen;
create policy section_seen_oauth_no_update on public.section_seen
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists section_seen_oauth_no_delete on public.section_seen;
create policy section_seen_oauth_no_delete on public.section_seen
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- Every section of the project the caller can see: its latest version,
-- the one they last saw, and whether it is new to them (never opened,
-- made after this arrived) or changed since they looked. As the caller:
-- the sections and versions are only those their own reads allow.
create or replace function public.abo_whats_new(p_project uuid)
returns jsonb
language sql stable set search_path = public as $$
  with since as (select timestamptz '2026-10-06 00:00:00+00' as at),
  latest as (
    select distinct on (u.module_id) u.module_id, u.version, u.created_at
      from public.ui_schemas u
      join public.modules m on m.id = u.module_id
     where m.project_id = p_project
     order by u.module_id, u.version desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'version', l.version,
           'seen', s.version,
           'fresh', s.version is null and m.created_at > since.at,
           'changed', case when s.version is not null then l.version > s.version
                           else m.created_at <= since.at and l.created_at > since.at end)), '[]'::jsonb)
    from public.modules m
    cross join since
    join latest l on l.module_id = m.id
    left join public.section_seen s on s.module_id = m.id and s.user_id = auth.uid()
   where m.project_id = p_project
$$;
revoke all on function public.abo_whats_new(uuid) from public, anon;
grant execute on function public.abo_whats_new(uuid) to authenticated;

-- The caller has seen a section as far as a version: kept, never lowered.
-- Not their own AI's: what it reads has not been in front of them.
create or replace function public.abo_seen(p_module uuid, p_version integer)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    return;
  end if;
  if p_version is null or p_version < 1 or not public.abo_can_see_module(p_module) then
    raise exception 'Not a section of yours.' using errcode = '42501';
  end if;
  insert into public.section_seen (user_id, module_id, version)
  values (auth.uid(), p_module, p_version)
  on conflict (user_id, module_id) do update
    set version = greatest(public.section_seen.version, excluded.version), seen_at = now();
end $$;
revoke all on function public.abo_seen(uuid, integer) from public, anon;
grant execute on function public.abo_seen(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
