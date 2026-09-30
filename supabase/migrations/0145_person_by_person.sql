-- Who sees what, person by person, as it happens.
--
-- 0140 let a section be shared with the whole team or with people picked
-- by name, from the section. The owner asked for the other way round too:
-- on each person, every section by name with a switch, so that someone
-- can have "everything the team has, except the margins". So a section
-- can now be hidden from one person, and hiding wins over everything
-- else that would show it to them — the team, a share by name, even
-- that they built it themselves.
--
-- A section also says who built it (created_by, from the session), so
-- the person who built it sees it without being given it: the ground a
-- team that builds stands on (0146).
--
-- And the People screen, and a member's own screen, hear it the moment
-- it changes: a seat taken, a name given, a switch flipped. The seats,
-- the shares and the hides stream to whoever may read them, which for a
-- member is their own seat and their own shares and hides.
--
-- Callers: src/lib/sharing.ts (module_shares, module_hides),
-- src/components/ProjectSettings.tsx, src/components/ShareSection.tsx,
-- src/components/AppShell.tsx (the streams), scripts/check-rls.mjs.

-- ── Who built it ─────────────────────────────────────────────

alter table public.modules add column if not exists created_by uuid;
comment on column public.modules.created_by is 'The login that built the section, from the session (0145); null for sections from before.';

create or replace function public.abo_module_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The session, never what was sent.
  new.created_by := auth.uid();
  return new;
end $$;
revoke all on function public.abo_module_stamp() from public, anon, authenticated;

drop trigger if exists trg_module_stamp on public.modules;
create trigger trg_module_stamp
  before insert on public.modules
  for each row execute function public.abo_module_stamp();

-- ── Hidden from one person ───────────────────────────────────

create table if not exists public.module_hides (
  module_id  uuid not null references public.modules(id) on delete cascade,
  member_id  uuid not null references public.project_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (module_id, member_id)
);
create index if not exists module_hides_member on public.module_hides (member_id);

alter table public.module_hides enable row level security;

-- The owner hides, and only a section from a seat of the same app.
drop policy if exists module_hides_owner_all on public.module_hides;
create policy module_hides_owner_all on public.module_hides
  for all to authenticated
  using (exists (select 1 from public.modules m where m.id = module_id and public.abo_owns(m.project_id)))
  with check (exists (
    select 1 from public.modules m
      join public.project_members pm on pm.project_id = m.project_id
     where m.id = module_id and pm.id = member_id and public.abo_owns(m.project_id)));

-- A member reads their own, so their screen hears it change.
drop policy if exists module_hides_self_read on public.module_hides;
create policy module_hides_self_read on public.module_hides
  for select to authenticated
  using (exists (select 1 from public.project_members pm where pm.id = member_id and pm.user_id = auth.uid()));
drop policy if exists module_shares_self_read on public.module_shares;
create policy module_shares_self_read on public.module_shares
  for select to authenticated
  using (exists (select 1 from public.project_members pm where pm.id = member_id and pm.user_id = auth.uid()));

drop policy if exists module_hides_oauth_no_insert on public.module_hides;
create policy module_hides_oauth_no_insert on public.module_hides
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists module_hides_oauth_no_update on public.module_hides;
create policy module_hides_oauth_no_update on public.module_hides
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists module_hides_oauth_no_delete on public.module_hides;
create policy module_hides_oauth_no_delete on public.module_hides
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── The gate, with the two new reasons ───────────────────────
-- 0140's, and: hidden from them wins over everything; built by them shows it.

create or replace function public.abo_can_see_module(p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.modules c
      join public.modules m on m.id = coalesce(c.parent_id, c.id)
     where c.id = p_module
       and (public.abo_owns(m.project_id)
            or (not exists (select 1 from public.module_hides h
                              join public.project_members pm on pm.id = h.member_id
                             where h.module_id = m.id and pm.user_id = auth.uid())
                and ((m.shared_with_team and public.abo_can_use(m.project_id))
                     or exists (select 1 from public.module_shares s
                                  join public.project_members pm on pm.id = s.member_id
                                 where s.module_id = m.id and pm.user_id = auth.uid())
                     or (m.created_by is not null and m.created_by = auth.uid()
                         and public.abo_can_use(m.project_id))))));
$$;

-- ── Heard as it happens ──────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'project_members') then
      alter publication supabase_realtime add table public.project_members;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'module_shares') then
      alter publication supabase_realtime add table public.module_shares;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'module_hides') then
      alter publication supabase_realtime add table public.module_hides;
    end if;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
