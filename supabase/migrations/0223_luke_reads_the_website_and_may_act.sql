-- Migration 0223: Luke reads their website, and may act where the owner lets him
--
-- What their website says (lib/site-read): the store's public pages, its
-- refund and shipping policies, read in the background and kept as lines
-- of what Luke knows (merchant_notes, 0220), marked as from the website so
-- a line the owner said is never overwritten by one read off a page:
--
--   merchant_notes.source    gains 'website'
--   projects.site_read_at    when the site was last read: read once on its
--                            own, again when the owner asks, at most every
--                            few minutes
--
-- A standing yes (lib/luke-may): the owner lets Luke change the rows of
-- one section without asking each time, and takes it back whenever they
-- like. Only the owner, in Warmluke, grants or revokes it; never their
-- own AI, never Luke. It applies only while the owner is the one talking
-- to Luke: the change is still made under the owner's own rights,
-- through the one door (lib/row-decide), so a teammate's chat or an AI's
-- token still waits in the bell.
--
--   luke_grants (project_id, module_id)   a section Luke may change rows in

alter table public.merchant_notes drop constraint if exists merchant_notes_source_check;
alter table public.merchant_notes add constraint merchant_notes_source_check
  check (source in ('owner', 'data', 'inferred', 'website'));

alter table public.projects add column if not exists site_read_at timestamptz;

create table if not exists public.luke_grants (
  project_id uuid not null references public.projects(id) on delete cascade,
  module_id  uuid not null references public.modules(id) on delete cascade,
  granted_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (project_id, module_id)
);
alter table public.luke_grants enable row level security;

drop policy if exists luke_grants_owner_all on public.luke_grants;
create policy luke_grants_owner_all on public.luke_grants
  for all to authenticated
  using (public.abo_owns(project_id))
  with check (
    public.abo_owns(project_id)
    and exists (select 1 from public.modules m where m.id = module_id and m.project_id = luke_grants.project_id)
  );

-- The wall: no connected client's token grants or revokes one.
drop policy if exists luke_grants_oauth_no_insert on public.luke_grants;
create policy luke_grants_oauth_no_insert on public.luke_grants
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists luke_grants_oauth_no_update on public.luke_grants;
create policy luke_grants_oauth_no_update on public.luke_grants
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists luke_grants_oauth_no_delete on public.luke_grants;
create policy luke_grants_oauth_no_delete on public.luke_grants
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

revoke all on public.luke_grants from public, anon;
grant select, insert, delete on public.luke_grants to authenticated;

notify pgrst, 'reload schema';
