-- A rule's schedule keeps a time of day, days of the week and a day of
-- the month, on the store's clock.
--
-- "Roz subah" ran whenever the rule happened to be made, and again a day
-- after that: a schedule had only an interval. A rule with no code had
-- not even that: the database ran every schedule rule every hour, so a
-- "daily" one ran twenty-four times a day.
--
-- A schedule trigger may now say
--   "at": "07:00"               the time, on the store's clock (its timezone; UTC without a store)
--   "on": ["mon", "sat"]        the days of the week it runs, daily or weekly
--   "every": "monthly", "date": 1   the day of the month; past a month's end, its last day
-- and runs at the latest such moment it has not run at, never at one from
-- before it was made: a rule made in the evening "at 07:00" first runs the
-- next morning. With none of them it runs as it did, an interval after its
-- last run. Both clocks ask one function whether a rule is due; a rule with
-- no code keeps when the clock last ran it, as a rule's code has its jobs.

alter table public.automations add column if not exists scheduled_at timestamptz;
comment on column public.automations.scheduled_at is 'When the schedule clock last ran this rule (a rule with no code; code rules keep code_jobs).';

/** The clock a project's rules keep: its store's timezone, or UTC. */
create or replace function public.abo_rule_tz(p_project uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.timezone from public.stores s
       where s.project_id = p_project and s.timezone in (select name from pg_timezone_names)
       order by (s.status = 'connected') desc
       limit 1),
    'UTC')
$$;

/**
 * The latest moment at or before p_now that a schedule names, on the
 * clock p_tz; null for a schedule that names none (an interval alone).
 */
create or replace function public.abo_schedule_slot(p_trigger jsonb, p_tz text, p_now timestamptz default now())
returns timestamptz
language plpgsql stable set search_path = public as $$
declare
  v_every text := coalesce(p_trigger->>'every', 'daily');
  v_at time;
  v_days int[];
  v_date int;
  v_local timestamp := p_now at time zone p_tz;
  v_first date;
  v_day date;
  v_slot timestamp;
  i int;
begin
  if coalesce(p_trigger->>'at', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    v_at := (p_trigger->>'at')::time;
  end if;
  select array_agg(x.dow) into v_days
    from (
      select case lower(d) when 'sun' then 0 when 'mon' then 1 when 'tue' then 2 when 'wed' then 3
                           when 'thu' then 4 when 'fri' then 5 when 'sat' then 6 end as dow
        from jsonb_array_elements_text(
               case jsonb_typeof(p_trigger->'on')
                 when 'array' then p_trigger->'on'
                 when 'string' then jsonb_build_array(p_trigger->'on')
                 else '[]'::jsonb end) d
    ) x
   where x.dow is not null;

  if v_every = 'monthly' then
    v_date := case when coalesce(p_trigger->>'date', '') ~ '^[0-9]{1,2}$' then (p_trigger->>'date')::int else 1 end;
    v_date := greatest(1, least(31, v_date));
    for i in 0..1 loop
      v_first := (date_trunc('month', v_local) - make_interval(months => i))::date;
      v_slot := v_first
                + (least(v_date, extract(day from (v_first + interval '1 month' - interval '1 day'))::int) - 1)
                + coalesce(v_at, time '00:00');
      if v_slot <= v_local then
        return v_slot at time zone p_tz;
      end if;
    end loop;
    return null;
  end if;

  -- Daily keeps a time or days; weekly, its days (a week "at 09:00" with no day says nothing).
  if (v_every = 'daily' and (v_at is not null or v_days is not null))
     or (v_every = 'weekly' and v_days is not null) then
    for i in 0..7 loop
      v_day := v_local::date - i;
      if v_days is not null and not (extract(dow from v_day)::int = any (v_days)) then
        continue;
      end if;
      v_slot := v_day + coalesce(v_at, time '00:00');
      if v_slot <= v_local then
        return v_slot at time zone p_tz;
      end if;
    end loop;
  end if;
  return null;
end $$;

/**
 * Whether a schedule rule is due: the latest moment it names has come,
 * since it was made and since it last ran; or, naming none, its interval
 * has passed since it last ran.
 */
create or replace function public.abo_schedule_due(
  p_trigger jsonb, p_tz text, p_last timestamptz, p_made timestamptz, p_now timestamptz default now()
)
returns boolean
language plpgsql stable set search_path = public as $$
declare
  v_slot timestamptz := public.abo_schedule_slot(p_trigger, p_tz, p_now);
begin
  if v_slot is not null then
    return v_slot >= p_made and (p_last is null or p_last < v_slot);
  end if;
  return p_last is null
      or p_last <= p_now
                 - case p_trigger->>'every' when 'hourly' then interval '1 hour'
                                            when 'weekly' then interval '7 days'
                                            else interval '1 day' end
                 + interval '5 minutes';
end $$;

/** Queues every scheduled code rule that is due, on its store's clock. */
create or replace function public.abo_code_schedule()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  a record;
  v_last timestamptz;
  v_queued integer := 0;
begin
  for a in
    select au.id, au.project_id, au.created_at, au.definition->'trigger' as trig
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
    select max(q.created_at) into v_last
      from public.code_jobs q
     where q.automation_id = a.id and q.kind = 'schedule';
    if not public.abo_schedule_due(a.trig, public.abo_rule_tz(a.project_id), v_last, a.created_at) then
      continue;
    end if;
    insert into public.code_jobs (project_id, automation_id, kind) values (a.project_id, a.id, 'schedule')
    on conflict do nothing;
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end $$;

-- The rules with no code: the same as 0135, run only when due, and the
-- clock's run kept on the rule (before it runs, so a rule that fails is
-- not tried again every tick).
create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  target record;
  v_source text;
  v_view   text;
  v_project uuid;
  v_rec_id uuid;
  v_rec_data jsonb;
  ctx jsonb;
  rec_data jsonb;
begin
  for auto in
    select a.*, m.source_table, m.project_id as module_project
    from public.automations a
    join public.modules m on m.id = a.module_id
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
      -- A rule's own code is the app's to run (code_jobs, below): walked
      -- here it would only lay an empty record beside every row it matched.
      and not (coalesce(a.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb)
    order by a.created_at, a.id
  loop
    if not public.abo_schedule_due(
         auto.definition->'trigger', public.abo_rule_tz(auto.module_project), auto.scheduled_at, auto.created_at
       ) then
      continue;
    end if;
    update public.automations set scheduled_at = now() where id = auto.id;
    begin
      v_source := auto.source_table;
      v_project := auto.module_project;
      if v_source is null then
        -- A section of their own: its records, as always.
        for target in
          select r.id, r.project_id, r.data
          from public.records r
          where r.module_id = auto.module_id
        loop
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.id);
          rec_data := coalesce(target.data, '{}'::jsonb) || jsonb_build_object('id', target.id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            target.id, target.project_id, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      else
        -- A section over the store: every row of this project's store,
        -- with the merchant's fields where a row has them. A row the
        -- rule acts on gets its record first, so there is something to
        -- write to.
        v_view := public.abo_store_view(v_source);
        if v_view is null then continue; end if;
        for target in execute format(
          'select v.id as row_id, to_jsonb(v) - ''store_id'' as row_data, r.id as rec_id, r.data as rec_data
             from public.%I v
             join public.stores s on s.id = v.store_id
             left join public.records r on r.module_id = $2 and r.store_row_id = v.id
            where s.project_id = $1', v_view) using v_project, auto.module_id
        loop
          rec_data := coalesce(target.rec_data, '{}'::jsonb) || target.row_data
                      || jsonb_build_object('id', coalesce(target.rec_id, target.row_id));
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.rec_id, 'store_row_id', target.row_id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          v_rec_id := target.rec_id;
          if v_rec_id is null then
            insert into public.records(project_id, module_id, store_row_id, data)
            values (v_project, auto.module_id, target.row_id, '{}'::jsonb)
            returning id into v_rec_id;
            rec_data := rec_data || jsonb_build_object('id', v_rec_id);
            ctx := ctx || jsonb_build_object('record_id', v_rec_id);
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            v_rec_id, v_project, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      end if;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$ language plpgsql security definer;

-- Asked every ten minutes, as the code clock is: a rule "at 07:30" runs at
-- 07:30, not at the next hour's :05. Whether it runs is up to the rule.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.alter_job(j.jobid, schedule := '*/10 * * * *')
       from cron.job j
      where j.jobname = 'abo-automation-runner';
  end if;
end $$;

revoke all on function public.abo_rule_tz(uuid) from public, anon, authenticated;
revoke all on function public.abo_schedule_slot(jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.abo_schedule_due(jsonb, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
