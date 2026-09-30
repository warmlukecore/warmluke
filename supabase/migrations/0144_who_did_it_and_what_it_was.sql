-- Who did it, and what it was before.
--
-- A row knew when it last changed and nothing else. "Who packed this?"
-- had one answer: a name field somebody typed, which is whatever anybody
-- typed. And a value changed was a value gone: "it said 12 this morning"
-- could not be looked up.
--
-- Now every row carries the login that added it and the login that last
-- changed it, written by the database from the signed-in session. What a
-- screen or a client sends for them is thrown away, so nobody can say it
-- was someone else. A write with no person behind it — the code worker,
-- an import — has none, and says so.
--
-- And every add, change and removal is kept, append-only: who, when, by
-- what (a person, a rule acting on their save, or the system), and the
-- row's fields before and after. Read by whoever may see the section;
-- written by nobody but the table's own trigger.
--
-- ponytail: kept for ever. Prune by age (or a last N per row) the day
-- record_events is the largest table.
--
-- Callers: the records table (trg_record_stamp, trg_record_history);
-- src/components/RecordModal.tsx (record_events, abo_names_for);
-- scripts/check-row-history.mjs.

-- ── Who, on the row ──────────────────────────────────────────

alter table public.records
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;

comment on column public.records.created_by is 'The login that added the row, from the session; null when no person did (0144).';
comment on column public.records.updated_by is 'The login that last changed the row, from the session; null when no person did (0144).';

create or replace function public.abo_record_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Never what the caller sent: the session says who, and only it.
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
  end if;
  new.updated_by := auth.uid();
  return new;
end $$;
revoke all on function public.abo_record_stamp() from public, anon, authenticated;

drop trigger if exists trg_record_stamp on public.records;
create trigger trg_record_stamp
  before insert or update on public.records
  for each row execute function public.abo_record_stamp();

-- ── What it was, kept ────────────────────────────────────────

create table if not exists public.record_events (
  id         bigint generated always as identity primary key,
  -- No foreign key: a removed row's history outlives it.
  record_id  uuid not null,
  module_id  uuid not null references public.modules(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  at         timestamptz not null default now(),
  actor      uuid,
  -- person: somebody's own write; rule: a rule acting on their save;
  -- system: no person behind it (the code worker, an import).
  via        text not null check (via in ('person', 'rule', 'system')),
  kind       text not null check (kind in ('added', 'changed', 'removed')),
  before     jsonb,
  after      jsonb
);
create index if not exists record_events_row on public.record_events (record_id, at desc);
create index if not exists record_events_section on public.record_events (module_id, at desc);

alter table public.record_events enable row level security;
revoke insert, update, delete on public.record_events from anon, authenticated;

-- Whoever may see the section may read what happened in it.
drop policy if exists record_events_read on public.record_events;
create policy record_events_read on public.record_events
  for select to authenticated
  using (public.abo_owns(project_id) or public.abo_can_see_module(module_id));

drop policy if exists record_events_oauth_no_insert on public.record_events;
create policy record_events_oauth_no_insert on public.record_events
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists record_events_oauth_no_update on public.record_events;
create policy record_events_oauth_no_update on public.record_events
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists record_events_oauth_no_delete on public.record_events;
create policy record_events_oauth_no_delete on public.record_events
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

create or replace function public.abo_record_history()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_via text := case
    when pg_trigger_depth() > 1 then 'rule'
    when auth.uid() is null then 'system'
    else 'person'
  end;
begin
  if TG_OP = 'INSERT' then
    insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
    values (new.id, new.module_id, new.project_id, auth.uid(), v_via, 'added', null, new.data);
  elsif TG_OP = 'UPDATE' then
    -- A save that changed nothing a person sees is not an event.
    if new.data is distinct from old.data then
      insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
      values (new.id, new.module_id, new.project_id, auth.uid(), v_via, 'changed', old.data, new.data);
    end if;
  else
    -- A row going with its section or its app: their history goes with
    -- them (the foreign keys cascade), so nothing is written for it. An
    -- event written here named a section already gone, and the foreign
    -- key refused it, and with it the whole delete of the section, the
    -- app, or the account.
    if not exists (select 1 from public.modules m where m.id = old.module_id) then
      return old;
    end if;
    insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
    values (old.id, old.module_id, old.project_id, auth.uid(), v_via, 'removed', old.data, null);
    return old;
  end if;
  return new;
end $$;
revoke all on function public.abo_record_history() from public, anon, authenticated;

drop trigger if exists trg_record_history on public.records;
create trigger trg_record_history
  after insert or update or delete on public.records
  for each row execute function public.abo_record_history();

-- ── Names for the people in an app ───────────────────────────

-- The owner and the team, as each other see them: the name each gave
-- (a seat's, or the owner's profile), else the part of the address
-- before the @. Only for someone who may use the app, and only for the
-- people in it: an id from anywhere else is not answered.
create or replace function public.abo_names_for(p_project uuid, p_ids uuid[])
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select u.id,
         coalesce(
           nullif(btrim(pm.full_name), ''),
           nullif(btrim(pr.full_name), ''),
           split_part(u.email::text, '@', 1)
         )
    from auth.users u
    left join public.project_members pm on pm.project_id = p_project and pm.user_id = u.id
    left join public.profiles pr on pr.user_id = u.id
   where u.id = any(p_ids)
     and public.abo_can_use(p_project)
     and (pm.user_id is not null
          or exists (select 1 from public.projects p where p.id = p_project and p.owner_id = u.id));
$$;
revoke all on function public.abo_names_for(uuid, uuid[]) from public, anon;
grant execute on function public.abo_names_for(uuid, uuid[]) to authenticated;

NOTIFY pgrst, 'reload schema';
