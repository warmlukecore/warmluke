-- Migration 0082: a judge that only watches.
--
-- Every design Luke or a connected assistant produces is shown, after
-- the answer has gone out, to a second model that gives probabilities
-- rather than prose: does what will be built do what the owner asked,
-- and could each line the design calls "unmet" have been built after
-- all. The answers change nothing. They land here so that, once real
-- merchants have been through, one query can say how often a design
-- missed the request — the number that decides whether those answers
-- should ever be allowed to stop an automatic build. Until then it is
-- a gauge, not a gate.
--
-- Written only through abo_judge_note: a connected client cannot write
-- at any table (0028), and this is server work either way.
--
-- Callers: src/lib/judge.ts (noteJudgement).

create table if not exists public.judgements (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Which road the design came down: the chat box or the MCP tool.
  source     text not null,
  -- The message or build request it belongs to, when there is one.
  ref        uuid,
  -- What the judge was shown, kept beside the verdict so a wrong one
  -- can be read against its evidence later.
  request    text not null,
  built      text not null,
  unmet      jsonb not null default '[]'::jsonb,
  -- Whether the plans remove a section: a fact read off the plans,
  -- not a judgement.
  removes    boolean not null default false,
  -- The answers as returned: {"addresses": 0.83, "unmet": [0.12, ...]}.
  judge      jsonb not null,
  model      text not null,
  ms         integer not null,
  created_at timestamptz not null default now(),
  constraint judgements_source_allowed check (source in ('chat', 'mcp'))
);
create index if not exists idx_judgements_project
  on public.judgements(project_id, created_at desc);

alter table public.judgements enable row level security;

-- The owner may read what was said about their designs. Nobody writes
-- at the table.
drop policy if exists "judgements_owner_read" on public.judgements;
create policy "judgements_owner_read" on public.judgements
  for select using (public.abo_owns(project_id));

create or replace function public.abo_judge_note(
  p_project uuid,
  p_source  text,
  p_ref     uuid,
  p_request text,
  p_built   text,
  p_unmet   jsonb,
  p_removes boolean,
  p_judge   jsonb,
  p_model   text,
  p_ms      integer
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if p_source not in ('chat', 'mcp') then
    raise exception 'Unknown source.' using errcode = '22023';
  end if;
  if p_judge is null or jsonb_typeof(p_judge) <> 'object' then
    raise exception 'A judgement is an object.' using errcode = '22023';
  end if;
  if p_unmet is not null and jsonb_typeof(p_unmet) <> 'array' then
    raise exception 'Unmet must be a list.' using errcode = '22023';
  end if;

  insert into public.judgements
    (project_id, source, ref, request, built, unmet, removes, judge, model, ms)
  values (
    p_project,
    p_source,
    p_ref,
    left(coalesce(p_request, ''), 2000),
    left(coalesce(p_built, ''), 4000),
    coalesce(p_unmet, '[]'::jsonb),
    coalesce(p_removes, false),
    p_judge,
    left(coalesce(p_model, ''), 40),
    greatest(coalesce(p_ms, 0), 0)
  )
  returning id into v_id;

  -- Evidence for a decision, not a record. Ninety days is longer than
  -- the question stays open, and sweeping on the way in means there
  -- is no job to forget to run.
  delete from public.judgements
   where project_id = p_project
     and created_at < now() - interval '90 days';

  return v_id;
end $$;

revoke all on function public.abo_judge_note(uuid, text, uuid, text, text, jsonb, boolean, jsonb, text, integer) from public;
grant execute on function public.abo_judge_note(uuid, text, uuid, text, text, jsonb, boolean, jsonb, text, integer) to authenticated;

NOTIFY pgrst, 'reload schema';
