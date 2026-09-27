-- Every turn leaves a trace.
--
-- What a turn did was told to the panel as it happened and kept on the
-- reply as a receipt, and that was all: which road, how many repairs
-- and for what, what the plan understood, what the critic said, what it
-- cost, how long it took — gone with the stream. Kept here, one row a
-- turn, so a week of turns can be read as a whole: what the grammar
-- refuses most, which asks go back, where the time goes. The owner may
-- read their own; nothing here is shown to the model.

create table if not exists public.turn_traces (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid,
  turn_id         uuid,
  road            text,
  model           text,
  steps           jsonb not null default '[]'::jsonb,
  usage           jsonb,
  repairs         integer not null default 0,
  repair_errors   jsonb not null default '[]'::jsonb,
  unmet           jsonb not null default '[]'::jsonb,
  plan_goal       text,
  critic          jsonb,
  took_ms         integer,
  created_at      timestamptz not null default now()
);
create index if not exists turn_traces_project_newest on public.turn_traces (project_id, created_at desc);

alter table public.turn_traces enable row level security;

-- Whoever may use the project reads its traces; the server writes them
-- on the owner's own client, so the same policy covers the write.
drop policy if exists turn_traces_member_all on public.turn_traces;
create policy turn_traces_member_all on public.turn_traces
  for all to authenticated
  using (public.abo_can_use(project_id))
  with check (public.abo_can_use(project_id));

-- And the wall every table has, whatever else it has: no write from a
-- connected client's token (check-rls asks abo_tables_missing_oauth_guard).
drop policy if exists turn_traces_oauth_no_insert on public.turn_traces;
create policy turn_traces_oauth_no_insert on public.turn_traces
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists turn_traces_oauth_no_update on public.turn_traces;
create policy turn_traces_oauth_no_update on public.turn_traces
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists turn_traces_oauth_no_delete on public.turn_traces;
create policy turn_traces_oauth_no_delete on public.turn_traces
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

NOTIFY pgrst, 'reload schema';
