-- A rule's own code says when it runs next.
--
-- 0137 gave a schedule a time, days and a date. Every other "when" a
-- merchant means (the first Monday, not on a holiday, every two hours in
-- shop hours) would have been one more word for the clock to learn. A
-- rule with code needs none of them: each run it is handed the store's
-- own clock and may hand back "next", a date and time on that clock, and
-- the clock calls it then. Everything about when is the rule's own code.
--
-- The platform keeps only the moment. It is cleared as a job is queued,
-- so a run that names no next falls back to the schedule's "every"; it is
-- never sooner than five minutes (a rule that answers "now" does not run
-- every tick) nor further than 400 days.

alter table public.automations add column if not exists next_run_at timestamptz;
comment on column public.automations.next_run_at is 'When a scheduled rule''s own code asked to run next (0138); null: its schedule decides.';

/** Queues every scheduled code rule that is due: at the moment its code named, else on its schedule. */
create or replace function public.abo_code_schedule()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  a record;
  v_last timestamptz;
  v_queued integer := 0;
begin
  for a in
    select au.id, au.project_id, au.created_at, au.next_run_at, au.definition->'trigger' as trig
      from public.automations au
     where au.enabled
       and au.definition->'trigger'->>'type' = 'schedule'
       and coalesce(au.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb
  loop
    if exists (
      select 1 from public.code_jobs q
       where q.automation_id = a.id and q.kind = 'schedule' and q.status in ('queued', 'running')
    ) then
      continue;
    end if;
    if a.next_run_at is not null then
      if a.next_run_at > now() then
        continue;
      end if;
    else
      select max(q.created_at) into v_last
        from public.code_jobs q
       where q.automation_id = a.id and q.kind = 'schedule';
      if not public.abo_schedule_due(a.trig, public.abo_rule_tz(a.project_id), v_last, a.created_at) then
        continue;
      end if;
    end if;
    insert into public.code_jobs (project_id, automation_id, kind) values (a.project_id, a.id, 'schedule')
    on conflict do nothing;
    -- The run says when next, or its schedule does.
    update public.automations set next_run_at = null where id = a.id;
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end $$;

/**
 * What a rule's code handed back as its next run, "YYYY-MM-DDTHH:MM" on
 * the store's clock, kept on the rule. Only with a ticket for the rule's
 * project; false for anything that is not such a moment.
 */
create or replace function public.abo_code_next(p_rule uuid, p_at text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_at timestamptz;
begin
  select au.project_id into v_project from public.automations au where au.id = p_rule;
  if v_project is null or not public.abo_code_holds(v_project) then
    return false;
  end if;
  if coalesce(p_at, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then
    return false;
  end if;
  begin
    v_at := replace(p_at, 'T', ' ')::timestamp at time zone public.abo_rule_tz(v_project);
  exception when others then
    return false;
  end;
  if v_at > now() + interval '400 days' then
    return false;
  end if;
  update public.automations set next_run_at = greatest(v_at, now() + interval '5 minutes') where id = p_rule;
  return true;
end $$;

revoke all on function public.abo_code_next(uuid, text) from public, authenticated;
-- The worker's client is anon carrying the project's ticket, as for abo_code_project (0134).
grant execute on function public.abo_code_next(uuid, text) to anon;

NOTIFY pgrst, 'reload schema';
