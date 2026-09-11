-- Migration 0017: staff logins
--
-- Every policy in this schema funnelled through one predicate —
-- `p.owner_id = auth.uid()`. That made the app honest but useless for
-- the problem it keeps being asked to solve: a picker and a packer are
-- two different people, and neither could open the app built for them.
--
-- Membership is claimed through a link, never asserted by email. This
-- project has mailer_autoconfirm on, so an address in a JWT proves
-- nothing — anyone could sign up as packer@example.com. The token is
-- the secret; auth.uid() is what gets stored.

create table if not exists public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Unclaimed until someone opens the link. The label is filled in on
  -- join so the owner sees who took it, rather than typing it blind.
  user_id    uuid references auth.users(id) on delete cascade,
  email      text,
  token      text not null unique default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  joined_at  timestamptz
);

-- One person, one seat per project.
create unique index if not exists idx_members_unique_user
  on public.project_members(project_id, user_id) where user_id is not null;
create index if not exists idx_members_user on public.project_members(user_id);

-- ── The gate ────────────────────────────────────────────────────
-- security definer so these never re-enter RLS: abo_can_use is called
-- FROM the policies on the very tables it reads.

create or replace function public.abo_owns(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects where id = p and owner_id = auth.uid());
$$;

create or replace function public.abo_can_use(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.abo_owns(p)
      or exists (select 1 from public.project_members
                 where project_id = p and user_id = auth.uid());
$$;

revoke all on function public.abo_owns(uuid) from public;
revoke all on function public.abo_can_use(uuid) from public;
grant execute on function public.abo_owns(uuid) to authenticated;
grant execute on function public.abo_can_use(uuid) to authenticated;

-- ── Claiming a seat ─────────────────────────────────────────────
-- One entry point instead of an RLS hole. A plain UPDATE policy over
-- unclaimed rows would let any signed-in user take a seat they could
-- name; here the token is the only way in, and it is never selectable.

create or replace function public.abo_join(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  update public.project_members
     set user_id   = auth.uid(),
         email     = auth.jwt()->>'email',
         joined_at = now()
   where token = p_token and user_id is null
   returning project_id into v_project;

  -- Re-opening a link you already used is not an error.
  if v_project is null then
    select project_id into v_project from public.project_members
     where token = p_token and user_id = auth.uid();
  end if;

  return v_project;  -- null: bad token, or already taken by someone else
end $$;

revoke all on function public.abo_join(text) from public;
grant execute on function public.abo_join(text) to authenticated;

alter table public.project_members enable row level security;

-- The owner manages seats. A member sees only their own row, and never
-- the token column's purpose — they cannot mint a seat for anyone else.
drop policy if exists "members_owner_all" on public.project_members;
create policy "members_owner_all" on public.project_members
  for all using (public.abo_owns(project_id)) with check (public.abo_owns(project_id));

drop policy if exists "members_self_read" on public.project_members;
create policy "members_self_read" on public.project_members
  for select using (user_id = auth.uid());

-- ── Policies ────────────────────────────────────────────────────
-- Staff run the app; they do not redesign it. Design (modules,
-- ui_schemas), the assistant thread and the rules stay with the owner,
-- so a packer cannot rename a field mid-shift or read the business
-- conversation that produced the app.

drop policy if exists "projects_owner_all" on public.projects;
create policy "projects_owner_all" on public.projects
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "projects_member_read" on public.projects;
create policy "projects_member_read" on public.projects
  for select using (public.abo_can_use(id));

drop policy if exists "modules_owner_all" on public.modules;
create policy "modules_owner_all" on public.modules
  for all using (public.abo_owns(project_id)) with check (public.abo_owns(project_id));

drop policy if exists "modules_member_read" on public.modules;
create policy "modules_member_read" on public.modules
  for select using (public.abo_can_use(project_id));

drop policy if exists "ui_schemas_owner_all" on public.ui_schemas;
create policy "ui_schemas_owner_all" on public.ui_schemas
  for all using (
    exists (select 1 from public.modules m
            where m.id = ui_schemas.module_id and public.abo_owns(m.project_id))
  )
  with check (
    exists (select 1 from public.modules m
            where m.id = ui_schemas.module_id and public.abo_owns(m.project_id))
  );

drop policy if exists "ui_schemas_member_read" on public.ui_schemas;
create policy "ui_schemas_member_read" on public.ui_schemas
  for select using (
    exists (select 1 from public.modules m
            where m.id = ui_schemas.module_id and public.abo_can_use(m.project_id))
  );

-- Rows are the whole point of a staff login: the picker marks Picked,
-- the packer scans. Delete stays with the owner — a mis-tap during a
-- shift should never be able to lose an order.
drop policy if exists "records_owner_all" on public.records;
create policy "records_owner_all" on public.records
  for all using (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_owns(m.project_id))
  )
  with check (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_owns(m.project_id))
  );

drop policy if exists "records_member_read" on public.records;
create policy "records_member_read" on public.records
  for select using (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_can_use(m.project_id))
  );

drop policy if exists "records_member_insert" on public.records;
create policy "records_member_insert" on public.records
  for insert with check (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_can_use(m.project_id))
  );

drop policy if exists "records_member_update" on public.records;
create policy "records_member_update" on public.records
  for update using (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_can_use(m.project_id))
  )
  with check (
    exists (select 1 from public.modules m
            where m.id = records.module_id and public.abo_can_use(m.project_id))
  );

-- Owner-only, unchanged in effect — rewritten through abo_owns so the
-- gate lives in one place and a future change cannot miss a table.
drop policy if exists "conversations_owner_all" on public.conversations;
create policy "conversations_owner_all" on public.conversations
  for all using (public.abo_owns(project_id)) with check (public.abo_owns(project_id));

drop policy if exists "messages_owner_all" on public.messages;
create policy "messages_owner_all" on public.messages
  for all using (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and public.abo_owns(c.project_id))
  )
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and public.abo_owns(c.project_id))
  );

drop policy if exists "automations_owner_all" on public.automations;
create policy "automations_owner_all" on public.automations
  for all using (public.abo_owns(project_id)) with check (public.abo_owns(project_id));

drop policy if exists "automation_runs_owner_read" on public.automation_runs;
create policy "automation_runs_owner_read" on public.automation_runs
  for select using (
    exists (select 1 from public.automations a
            where a.id = automation_runs.automation_id and public.abo_owns(a.project_id))
  );

NOTIFY pgrst, 'reload schema';
