-- Migration 0007: business-logic layer
-- Automations are DATA (trigger/condition/actions JSON). A Postgres
-- trigger engine executes them on every record write — so they fire
-- for app edits, API writes, anything. Schedules use pg_cron.

-- ── Automations (versioned, per project, RLS-scoped) ─────────
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  module_id uuid references public.modules(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  definition jsonb not null,          -- { trigger, conditions?, actions[] }
  created_at timestamptz not null default now()
);
create index if not exists idx_automations_project on public.automations(project_id);
create index if not exists idx_automations_module on public.automations(module_id);

-- ── Run log (audit trail) ────────────────────────────────────
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations(id) on delete cascade,
  record_id uuid,
  ok boolean not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_automation_runs_auto on public.automation_runs(automation_id, created_at desc);

alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;

create policy "automations_owner_all" on public.automations
  for all using (
    exists (select 1 from public.projects p
            where p.id = automations.project_id and p.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from public.projects p
            where p.id = automations.project_id and p.owner_id = auth.uid())
  );

create policy "automation_runs_owner_read" on public.automation_runs
  for select using (
    exists (
      select 1 from public.automations a
      join public.projects p on p.id = a.project_id
      where a.id = automation_runs.automation_id and p.owner_id = auth.uid()
    )
  );

-- ── Engine: runs automations for a record write ─────────────
-- security definer: the engine runs as the function owner so its
-- cross-record effects are system-level (not limited by the acting
-- user's RLS). Only fixed SQL patterns with bound jsonb values —
-- no dynamic SQL, so user JSON cannot inject.
create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  act jsonb;
  cond jsonb;
  all_match boolean;
  affected integer;
  err text;
  rec_data jsonb := coalesce(to_jsonb(new.data), '{}'::jsonb);
  old_data jsonb := coalesce(to_jsonb(old.data), '{}'::jsonb);
begin
  for auto in
    select * from public.automations a
    where a.enabled
      and a.module_id = new.module_id
  loop
    begin
      -- TRIGGER gating
      if (auto.definition->'trigger'->>'type') = 'record_created' then
        if TG_OP <> 'INSERT' then continue; end if;
      elsif (auto.definition->'trigger'->>'type') = 'record_updated' then
        if TG_OP <> 'UPDATE' then continue; end if;
        -- optional "when": field must change TO this value
        if auto.definition->'trigger' ? 'when' then
          if coalesce(rec_data->>(auto.definition->'trigger'->'when'->>'field'), '')
             <> (auto.definition->'trigger'->'when'->>'equals') then
            continue;
          end if;
          if coalesce(old_data->>(auto.definition->'trigger'->'when'->>'field'), '')
             = (auto.definition->'trigger'->'when'->>'equals') then
            continue;
          end if;
        end if;
      else
        continue; -- schedule-type handled by pg_cron, not row triggers
      end if;

      -- CONDITION(S) — all must match the current record
      if auto.definition ? 'conditions' then
        all_match := true;
        for cond in select * from jsonb_array_elements(auto.definition->'conditions') loop
          if coalesce(rec_data->>(cond->>'field'), '') <> (cond->>'equals') then
            all_match := false;
            exit;
          end if;
        end loop;
        if not all_match then continue; end if;
      end if;

      -- ACTIONS
      for act in select * from jsonb_array_elements(auto.definition->'actions') loop
        if act->>'type' = 'update_related' then
          update public.records r
          set data = r.data
              || jsonb_build_object(
                   act->'operation'->>'field',
                   case act->'operation'->>'math'
                     when 'add' then
                       coalesce((r.data->>(act->'operation'->>'field'))::numeric, 0)
                       + coalesce((rec_data->>(act->'operation'->>'value_from'))::numeric, (act->'operation'->>'value')::numeric, 0)
                     when 'subtract' then
                       coalesce((r.data->>(act->'operation'->>'field'))::numeric, 0)
                       - coalesce((rec_data->>(act->'operation'->>'value_from'))::numeric, (act->'operation'->>'value')::numeric, 0)
                     else
                       coalesce(rec_data->>(act->'operation'->>'value_from'), act->'operation'->>'value')
                   end
                 )
              , updated_at = now()
          where r.module_id = (act->>'module_id')::uuid
            and r.data->>(act->'match'->>'field')
                = coalesce(rec_data->>(act->'match'->>'from_record_field'), act->'match'->>'value');
          get diagnostics affected = row_count;
          insert into public.automation_runs(automation_id, record_id, ok, detail)
          values (auto.id, new.id, true,
                  jsonb_build_object('action', 'update_related', 'rows', affected));
        elsif act->>'type' = 'create_record' then
          insert into public.records(project_id, module_id, data)
          values (new.project_id, (act->>'module_id')::uuid, coalesce(act->'data', '{}'::jsonb));
          insert into public.automation_runs(automation_id, record_id, ok, detail)
          values (auto.id, new.id, true, jsonb_build_object('action', 'create_record'));
        elsif act->>'type' = 'webhook' then
          -- Queued as a log entry; delivered by the app's worker (phase 2).
          insert into public.automation_runs(automation_id, record_id, ok, detail)
          values (auto.id, new.id, true,
                  jsonb_build_object('action', 'webhook', 'url', act->>'url', 'queued', true));
        end if;
      end loop;

    exception when others then
      err := sqlerrm;
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, new.id, false, jsonb_build_object('error', err));
    end;
  end loop;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_record_automations on public.records;
create trigger trg_record_automations
after insert or update on public.records
for each row execute function public.run_record_automations();

-- ── Scheduled automations runner (called by pg_cron hourly) ──
create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  act jsonb;
  target record;
begin
  for auto in
    select a.*, null::uuid as _unused
    from public.automations a
    where a.enabled
      and (a.definition->'trigger'->>'type') = 'schedule'
  loop
    begin
      for target in
        select r.id, r.project_id, r.data
        from public.records r
        where r.module_id = auto.module_id
          and coalesce(r.data->>((auto.definition->'trigger'->'when'->>'field')), '')
              = (auto.definition->'trigger'->'when'->>'equals')
      loop
        for act in select * from jsonb_array_elements(auto.definition->'actions') loop
          if act->>'type' = 'update_related' then
            update public.records r
            set data = r.data
                || jsonb_build_object(
                     act->'operation'->>'field',
                     case act->'operation'->>'math'
                       when 'add' then coalesce((r.data->>(act->'operation'->>'field'))::numeric, 0)
                         + coalesce((target.data->>(act->'operation'->>'value_from'))::numeric, (act->'operation'->>'value')::numeric, 0)
                       when 'subtract' then coalesce((r.data->>(act->'operation'->>'field'))::numeric, 0)
                         - coalesce((target.data->>(act->'operation'->>'value_from'))::numeric, (act->'operation'->>'value')::numeric, 0)
                       else coalesce(target.data->>(act->'operation'->>'value_from'), act->'operation'->>'value')
                     end
                   )
                , updated_at = now()
            where r.module_id = (act->>'module_id')::uuid
              and r.data->>(act->'match'->>'field')
                  = coalesce(target.data->>(act->'match'->>'from_record_field'), act->'match'->>'value');
          elsif act->>'type' = 'create_record' then
            insert into public.records(project_id, module_id, data)
            values (target.project_id, (act->>'module_id')::uuid, coalesce(act->'data', '{}'::jsonb));
          end if;
        end loop;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto.id, target.id, true, jsonb_build_object('run', 'scheduled'));
      end loop;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$ language plpgsql security definer;

-- Register the hourly runner (idempotent).
do $reg$
begin
  if not exists (select 1 from cron.job where jobname = 'abo-automation-runner') then
    perform cron.schedule('abo-automation-runner', '5 * * * *',
                          $cmd$select public.run_scheduled_automations();$cmd$);
  end if;
exception when others then
  -- pg_cron not available on this plan; schedules then run only when
  -- the app calls run_scheduled_automations() manually.
  null;
end $reg$;

-- Added later, when a check started asking: a redefined function
-- PostgREST is not told about is one the API keeps calling by its old
-- signature. Idempotent, so appending it to an applied migration
-- changes nothing that ran.
NOTIFY pgrst, 'reload schema';
