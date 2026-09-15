-- Migration 0041: letting an assistant build without asking.
--
-- Off, and per project. The risk belongs to the app, not the account:
-- a merchant may want this on the thing they are experimenting with
-- and never on the one their staff use every day.
--
-- The switch is the small part. The gate is the feature, and it lives
-- in the MCP route where a design is judged before it is applied:
-- additive changes only, nothing the engine flagged, and a daily cap
-- so a client in a loop cannot build fifty sections overnight.
--
-- Callers: src/app/api/mcp/route.ts (reads it), src/app/api/projects
-- (writes it), src/components/ProjectSettings.tsx.

alter table public.projects
  add column if not exists auto_build boolean not null default false;

-- Counting what an assistant built on its own, for the daily cap.
-- Only automatic builds count: a merchant approving ten designs in an
-- afternoon is not the thing being guarded against.
alter table public.build_requests
  add column if not exists auto_built boolean not null default false;

create index if not exists idx_build_requests_auto
  on public.build_requests(project_id, built_at desc)
  where auto_built;

-- Turning this on is a decision a person makes in the app. A token
-- carrying client_id is refused every write by 0028, so an assistant
-- cannot grant itself permission to skip approval — this says so
-- where somebody reading the schema will see it.
comment on column public.projects.auto_build is
  'Owner-set. Additive designs from an AI apply without approval; see the gate in /api/mcp.';

NOTIFY pgrst, 'reload schema';
