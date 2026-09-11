-- Migration 0009: scope module uniqueness to the project.
-- modules.name and modules.route carried UNIQUE constraints from the
-- single-tenant prototype. Migration 0004 added project_id but left them
-- global, so the first owner to create a "bookings" section permanently
-- blocked every other owner on the platform from having one. Uniqueness
-- belongs per project, which is also what the app already validates.

alter table public.modules drop constraint if exists modules_name_key;
alter table public.modules drop constraint if exists modules_route_key;

create unique index if not exists modules_project_name_key
  on public.modules (project_id, name);
create unique index if not exists modules_project_route_key
  on public.modules (project_id, route);

NOTIFY pgrst, 'reload schema';
