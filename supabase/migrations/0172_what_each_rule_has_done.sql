-- Migration 0172: what each rule has done
--
-- The Rules dialog said whether a rule had run from the newest 200 runs
-- of every rule together, and only from automation_runs. A rule of code
-- leaves its runs in code_jobs instead, so Tanish's "Flag repeat orders",
-- 25 runs without an error, read "Hasn't run yet"; and one busy rule (an
-- hourly one writing 2,353 rows at once) pushed every other rule's runs
-- out of the 200. He had to ask us "are there any logs of it working?".
--
-- Now one call says, for each rule, how many times it ran, how many of
-- those failed, and its last run: when, whether it worked, and its error.
-- Both kinds of run, counted in the database. It runs as the caller, so
-- it sees exactly the rules and runs their own policies let them see.

create index if not exists code_jobs_by_rule on public.code_jobs (automation_id, created_at desc);

create or replace function public.abo_rule_log(p_project uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(a.id, jsonb_build_object(
           'runs', (select count(*) from public.automation_runs r where r.automation_id = a.id)
                 + (select count(*) from public.code_jobs j where j.automation_id = a.id and j.status in ('done', 'failed')),
           'failed', (select count(*) from public.automation_runs r where r.automation_id = a.id and not r.ok)
                   + (select count(*) from public.code_jobs j where j.automation_id = a.id and j.status = 'failed'),
           'last', (select to_jsonb(x) from (
                     (select r.created_at as at, r.ok, r.detail->>'error' as error
                        from public.automation_runs r where r.automation_id = a.id
                       order by r.created_at desc limit 1)
                     union all
                     (select coalesce(j.finished_at, j.created_at), j.status = 'done', j.error
                        from public.code_jobs j where j.automation_id = a.id and j.status in ('done', 'failed')
                       order by j.created_at desc limit 1)
                     order by at desc limit 1) x))), '{}'::jsonb)
    from public.automations a
   where a.project_id = p_project
$$;
revoke all on function public.abo_rule_log(uuid) from public, anon;
grant execute on function public.abo_rule_log(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
