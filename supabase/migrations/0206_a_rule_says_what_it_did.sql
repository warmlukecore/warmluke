-- Migration 0206: a rule says what it did
--
-- Tanish's Parent Stock sync ran on every save for a day and wrote
-- nothing, and nothing anywhere said so (11 Oct). A rule of code run
-- after the owner's own write logged only to the server's console; the
-- Rules dialog read "Hasn't run yet", and Luke, asked, told the owner to
-- check it themselves. Its code was handed the first 500 of 2,058 stock
-- rows, and the 34 it was for were not among them.
--
-- So every run of every rule is kept in one place, automation_runs:
-- - a rule of expressions, as before (the database's triggers);
-- - a rule's AI step, as before (0182);
-- - a rule of code, after the owner's write and from the queue alike,
--   through abo_rule_ran, with what it read of each section (and whether
--   a read was cut short), what it wrote, what was refused and why.
--
-- A queued job's run names its job (detail.job), so the job is not
-- counted a second time beside it. The log is kept sixty days; older
-- runs are folded into the rule's own totals before they go, so "ran N
-- times" stays the whole count (abo_rule_runs_sweep, daily).

alter table public.automations
  add column if not exists runs_before   bigint not null default 0,
  add column if not exists failed_before bigint not null default 0;

create index if not exists automation_runs_job
  on public.automation_runs ((detail->>'job')) where detail ? 'job';

-- ── A run of code, kept ──────────────────────────────────────
/**
 * One run of a rule's code: by the owner (or a teammate) whose write it
 * followed, or by the project's code ticket for a queued one. Its detail
 * is held to a size a log should be, and cannot pose as an AI step.
 */
create or replace function public.abo_rule_ran(p_rule uuid, p_record uuid, p_ok boolean, p_detail jsonb)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_detail  jsonb := coalesce(p_detail, '{}'::jsonb);
begin
  select a.project_id into v_project from public.automations a where a.id = p_rule;
  if v_project is null then
    return;
  end if;
  if not (public.abo_can_use(v_project) or public.abo_code_holds(v_project)) then
    raise exception 'Not a rule of this caller''s.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_detail) <> 'object' then
    v_detail := '{}'::jsonb;
  end if;
  v_detail := v_detail - 'ai';
  if length(v_detail::text) > 4000 then
    v_detail := jsonb_strip_nulls(jsonb_build_object(
      'kind', v_detail->'kind', 'trigger', v_detail->'trigger', 'wrote', v_detail->'wrote',
      'refused', v_detail->'refused', 'dropped', v_detail->'dropped', 'job', v_detail->'job',
      'error', left(v_detail->>'error', 300), 'trimmed', true));
  end if;
  insert into public.automation_runs (automation_id, record_id, ok, detail)
  values (p_rule, p_record, coalesce(p_ok, false), v_detail);
end $$;
revoke all on function public.abo_rule_ran(uuid, uuid, boolean, jsonb) from public;
grant execute on function public.abo_rule_ran(uuid, uuid, boolean, jsonb) to anon, authenticated;

-- ── What each rule has done ──────────────────────────────────
-- 0172's, with the runs folded away by the sweep, a queued job counted
-- once, and the last run's rows written and whether a read was cut short.
create or replace function public.abo_rule_log(p_project uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(a.id, jsonb_build_object(
           'runs', a.runs_before
                 + (select count(*) from public.automation_runs r where r.automation_id = a.id)
                 + (select count(*) from public.code_jobs j where j.automation_id = a.id and j.status in ('done', 'failed')
                       and not exists (select 1 from public.automation_runs r where r.detail->>'job' = j.id::text and r.detail ? 'job')),
           'failed', a.failed_before
                   + (select count(*) from public.automation_runs r where r.automation_id = a.id and not r.ok)
                   + (select count(*) from public.code_jobs j where j.automation_id = a.id and j.status = 'failed'
                         and not exists (select 1 from public.automation_runs r where r.detail->>'job' = j.id::text and r.detail ? 'job')),
           'last', (select to_jsonb(x) from (
                     (select r.created_at as at, r.ok, r.detail->>'error' as error,
                             coalesce((case when jsonb_typeof(r.detail->'wrote') = 'number' then (r.detail->>'wrote')::numeric::integer end),
                                      (case when jsonb_typeof(r.detail->'rows') = 'number' then (r.detail->>'rows')::numeric::integer end),
                                      -- a rule of expressions says what it did, not a count: one row made, or its own row set
                                      (case when r.detail->>'action' = 'create_record'
                                              or (r.detail->>'action' = 'set_fields' and r.detail->>'on' = 'self') then 1 end)) as wrote,
                             (coalesce((case when jsonb_typeof(r.detail->'dropped') = 'number' then (r.detail->>'dropped')::numeric::integer end), 0) > 0
                              or (jsonb_typeof(r.detail->'read') = 'object'
                                  and exists (select 1 from jsonb_each(r.detail->'read') e where e.value->>'cut' = 'true'))) as cut
                        from public.automation_runs r where r.automation_id = a.id
                       order by r.created_at desc limit 1)
                     union all
                     (select coalesce(j.finished_at, j.created_at), j.status = 'done', j.error, null::integer, false
                        from public.code_jobs j where j.automation_id = a.id and j.status in ('done', 'failed')
                       order by j.created_at desc limit 1)
                     order by at desc limit 1) x))), '{}'::jsonb)
    from public.automations a
   where a.project_id = p_project
$$;
revoke all on function public.abo_rule_log(uuid) from public, anon;
grant execute on function public.abo_rule_log(uuid) to authenticated;

-- ── Each run, newest first ───────────────────────────────────
/**
 * The newest runs of a project's rules, or of one rule by its id or name:
 * for Luke and the owner's own AI, which read what happened instead of
 * asking the owner to look. Read as the caller, under the tables' own walls.
 */
create or replace function public.abo_rule_runs(p_project uuid, p_rule text default null, p_limit integer default 20)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with rules as (
    select a.id, a.name, a.definition->'trigger'->>'type' as trigger
      from public.automations a
     where a.project_id = p_project
       and (p_rule is null or a.id::text = p_rule or lower(a.name) = lower(btrim(p_rule)))
  ), runs as (
    (select r.created_at as at, u.name as rule, u.id as rule_id, u.trigger, r.ok, r.record_id,
            r.detail->'read' as read,
            coalesce((case when jsonb_typeof(r.detail->'wrote') = 'number' then (r.detail->>'wrote')::numeric::integer end),
                                      (case when jsonb_typeof(r.detail->'rows') = 'number' then (r.detail->>'rows')::numeric::integer end),
                                      -- a rule of expressions says what it did, not a count: one row made, or its own row set
                                      (case when r.detail->>'action' = 'create_record'
                                              or (r.detail->>'action' = 'set_fields' and r.detail->>'on' = 'self') then 1 end)) as wrote,
            coalesce((case when jsonb_typeof(r.detail->'refused') = 'number' then (r.detail->>'refused')::numeric::integer end), 0) as refused,
            coalesce((case when jsonb_typeof(r.detail->'dropped') = 'number' then (r.detail->>'dropped')::numeric::integer end), 0) as dropped,
            coalesce(r.detail->>'error', case when r.detail ? 'ai' then null end) as error,
            case when r.detail ? 'ai' then 'ai' when r.detail->>'kind' = 'code' then 'code' else 'expressions' end as kind
       from public.automation_runs r join rules u on u.id = r.automation_id
      order by r.created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 200))
    union all
    (select coalesce(j.finished_at, j.created_at), u.name, u.id, u.trigger, j.status = 'done', null,
            null, null, 0, 0, j.error, 'code'
       from public.code_jobs j join rules u on u.id = j.automation_id
      where j.status in ('done', 'failed')
        and not exists (select 1 from public.automation_runs r where r.detail->>'job' = j.id::text and r.detail ? 'job')
      order by j.created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 200))
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb)
    from (select * from runs order by at desc limit least(greatest(coalesce(p_limit, 20), 1), 200)) x
$$;
revoke all on function public.abo_rule_runs(uuid, text, integer) from public, anon;
grant execute on function public.abo_rule_runs(uuid, text, integer) to authenticated;

-- ── Kept sixty days ──────────────────────────────────────────
/** Folds runs older than sixty days into each rule's totals, then lets them go; finished jobs too. Internal. */
create or replace function public.abo_rule_runs_sweep() returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_cut  timestamptz := now() - interval '60 days';
  v_gone integer;
begin
  with old as (
    select automation_id, count(*) as n, count(*) filter (where not ok) as f
      from public.automation_runs where created_at < v_cut group by automation_id
  )
  update public.automations a
     set runs_before = a.runs_before + old.n, failed_before = a.failed_before + old.f
    from old where a.id = old.automation_id;
  -- A finished job counted on its own (one from before 0206, with no run
  -- of its own) is folded the same way; one with a run was counted there.
  with old as (
    select j.automation_id, count(*) as n, count(*) filter (where j.status = 'failed') as f
      from public.code_jobs j
     where j.status in ('done', 'failed') and j.created_at < v_cut
       and not exists (select 1 from public.automation_runs r where r.detail->>'job' = j.id::text and r.detail ? 'job')
     group by j.automation_id
  )
  update public.automations a
     set runs_before = a.runs_before + old.n, failed_before = a.failed_before + old.f
    from old where a.id = old.automation_id;
  delete from public.code_jobs where status in ('done', 'failed') and created_at < v_cut;
  delete from public.automation_runs where created_at < v_cut;
  get diagnostics v_gone = row_count;
  return v_gone;
end $$;
revoke all on function public.abo_rule_runs_sweep() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-rule-runs-sweep', '17 3 * * *', 'select public.abo_rule_runs_sweep()');
  end if;
end $$;

notify pgrst, 'reload schema';
