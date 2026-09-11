-- Migration 0004: multi-tenant SaaS foundation
-- Every user owns projects; all app data hangs off projects with
-- owner-only RLS so isolation is enforced by the database itself.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled project',
  description text,
  created_at timestamptz not null default now()
);

alter table public.modules add column if not exists project_id uuid references public.projects(id) on delete cascade;
alter table public.records add column if not exists project_id uuid references public.projects(id) on delete cascade;

-- Backfill from existing single-tenant rows (prototype data).
update public.modules set project_id = p.id
from public.projects p where p.name = '__legacy__' and modules.project_id is null;
update public.records set project_id = m.project_id
from public.modules m where records.project_id is null and records.module_id = m.id;

-- Owner-only RLS everywhere.
alter table public.projects enable row level security;
alter table public.modules enable row level security;
alter table public.records enable row level security;
alter table public.ui_schemas enable row level security;

drop policy if exists "modules_all" on public.modules;
drop policy if exists "records_all" on public.records;
drop policy if exists "ui_schemas_all" on public.ui_schemas;
drop policy if exists "projects_owner_all" on public.projects;
drop policy if exists "modules_owner_all" on public.modules;
drop policy if exists "records_owner_all" on public.records;
drop policy if exists "ui_schemas_owner_all" on public.ui_schemas;

create policy "projects_owner_all" on public.projects
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "modules_owner_all" on public.modules
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = modules.project_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = modules.project_id and p.owner_id = auth.uid()
    )
  );

create policy "records_owner_all" on public.records
  for all using (
    exists (
      select 1 from public.modules m
      join public.projects p on p.id = m.project_id
      where m.id = records.module_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.modules m
      join public.projects p on p.id = m.project_id
      where m.id = records.module_id and p.owner_id = auth.uid()
    )
  );

create policy "ui_schemas_owner_all" on public.ui_schemas
  for all using (
    exists (
      select 1 from public.modules m
      join public.projects p on p.id = m.project_id
      where m.id = ui_schemas.module_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.modules m
      join public.projects p on p.id = m.project_id
      where m.id = ui_schemas.module_id and p.owner_id = auth.uid()
    )
  );

create index if not exists idx_modules_project on public.modules(project_id);
create index if not exists idx_records_project on public.records(project_id);
create index if not exists idx_ui_schemas_module on public.ui_schemas(module_id);

NOTIFY pgrst, 'reload schema';
