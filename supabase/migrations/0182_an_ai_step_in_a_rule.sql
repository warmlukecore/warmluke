-- An AI step in a rule (#5, 5 Oct).
--
-- A rule can read a row's own words (a note, a pasted message) and fill
-- other fields of it: one of a field's own choices, or a value taken out
-- of the words (automation action "ai_fill"). The app runs it after the
-- owner's write, on a small model (lib/code-rules.ts, lib/ai-fill.ts);
-- this database runs none of it (abo_run_actions passes over any action
-- it does not know, as it does run_code). What this file holds is what
-- the database must: how many a project may run in a day, said once, and
-- a record of each run in the rule's own history (automation_runs), with
-- what it filled, what it left and what it cost.
--
-- Past the day's limit a run is not started. The rule says so once a day
-- in the bell (abo_rule_alert, 0164), and the row stays as it was saved.
-- A day is UTC's.

-- A run begins: its place in the rule's history, or null when the rule is
-- not this caller's to run, or the project has used its day.
create or replace function public.abo_ai_fill_claim(p_automation uuid, p_record uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_used    integer;
  v_run     uuid;
  -- ponytail: one limit for every store; by plan once there are plans.
  c_limit   constant integer := 200;
begin
  select m.project_id into v_project
    from public.automations a
    join public.modules m on m.id = a.module_id
   where a.id = p_automation and a.enabled;
  if v_project is null or not public.abo_can_use(v_project) then
    return null;
  end if;
  -- One count at a time a project, so two saves at once cannot both take the last run.
  perform pg_advisory_xact_lock(hashtext('ai_fill:' || v_project::text));
  -- This project's rules, each read by its own (automation_id, created_at)
  -- index: never every project's runs of the day.
  select count(*) into v_used
    from public.automation_runs r
   where r.automation_id = any(array(
           select a.id from public.automations a
             join public.modules m on m.id = a.module_id
            where m.project_id = v_project))
     and r.created_at >= date_trunc('day', now())
     and r.detail ? 'ai';
  if v_used >= c_limit then
    perform public.abo_rule_alert(
      p_automation, v_project, 'ai-limit ' || to_char(now(), 'YYYY-MM-DD'), '{}'::jsonb,
      jsonb_build_object('title', 'AI steps paused until tomorrow: ' || c_limit || ' used today', 'severity', 'attention')
    );
    return null;
  end if;
  insert into public.automation_runs (automation_id, record_id, ok, detail)
  values (p_automation, p_record, true, jsonb_build_object('ai', 'running'))
  returning id into v_run;
  return v_run;
end $$;
revoke all on function public.abo_ai_fill_claim(uuid, uuid) from public, anon;
grant execute on function public.abo_ai_fill_claim(uuid, uuid) to authenticated;

-- A run ends: what it filled, what it left and what it cost, on its own line only.
create or replace function public.abo_ai_fill_done(p_run uuid, p_ok boolean, p_detail jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.automation_runs r
     set ok = p_ok,
         detail = jsonb_build_object('ai', case when p_ok then 'filled' else 'failed' end)
                  || (coalesce(p_detail, '{}'::jsonb) - 'ai')
   where r.id = p_run
     and r.detail ->> 'ai' = 'running'
     and exists (
       select 1 from public.automations a
         join public.modules m on m.id = a.module_id
        where a.id = r.automation_id and public.abo_can_use(m.project_id)
     );
end $$;
revoke all on function public.abo_ai_fill_done(uuid, boolean, jsonb) from public, anon;
grant execute on function public.abo_ai_fill_done(uuid, boolean, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
