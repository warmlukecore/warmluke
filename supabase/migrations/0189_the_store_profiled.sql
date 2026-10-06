-- The store, profiled for the designer (Scout, 6 Oct).
--
-- Before a design, Luke was told each store list in words and asked to
-- guess its column names; a wrong guess came back from the validator for
-- repair (12 of the last month's repairs named a column that was not
-- there). This reads every list the app names in one call and says, per
-- column: what kind of value it holds, how often it is filled, how many
-- different values it has, and when there are few, which ones and how
-- often. A sample of the newest rows is enough to say that, and keeps it
-- quick on a store of any size.
--
-- The lists come from the caller (lib/scout reads them off STORE_TABLES,
-- so a list added there is profiled without a change here); each must be
-- a view of this schema with a store_id, and is read as the caller: every
-- store view is security_invoker, so what this returns is what the caller
-- could read row by row anyway.
--
-- Callers: src/lib/scout.ts.

create or replace function public.abo_store_profile(p_store uuid, p_views text[], p_sample integer default 2000)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_view text;
  v_one  jsonb;
  v_out  jsonb := '{}'::jsonb;
  v_n    integer := least(greatest(coalesce(p_sample, 2000), 100), 5000);
begin
  for v_view in
    select v.table_name::text
      from information_schema.views v
     where v.table_schema = 'public'
       and v.table_name = any(coalesce(p_views, '{}'))
       and exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = v.table_name and c.column_name = 'store_id')
  loop
    execute format($q$
      with s as (
        select to_jsonb(v) - 'store_id' - 'project_id' as j
          from public.%I v where v.store_id = $1 limit $2),
      n as (select count(*)::integer as c from s),
      kv as (select e.key, e.value from s, jsonb_each(s.j) e),
      keys as (select distinct key from kv),
      filled as (
        select key, value from kv
         where value is not null and value not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)),
      per as (
        select key, mode() within group (order by jsonb_typeof(value)) as kind,
               count(*) as filled, count(distinct value) as distinct_n
          from filled group by key),
      vals as (
        select key, value #>> '{}' as v, count(*) as cnt
          from filled where jsonb_typeof(value) in ('string', 'boolean') group by key, value)
      select jsonb_build_object(
               'sampled', (select c from n),
               'columns', coalesce(jsonb_object_agg(k.key, jsonb_build_object(
                 'type', coalesce(p.kind, 'empty'),
                 'filled', case when (select c from n) > 0
                                then round(100.0 * coalesce(p.filled, 0) / (select c from n)) end,
                 'distinct', coalesce(p.distinct_n, 0),
                 -- A few values that repeat: a category. Every value its own (an id, a name) is not one.
                 'values', case when p.distinct_n between 1 and 25 and p.distinct_n < greatest((select c from n), 2)
                                 and p.kind in ('string', 'boolean') then
                   (select jsonb_object_agg(x.v, x.cnt)
                      from (select v, cnt from vals where vals.key = k.key order by cnt desc, v) x) end
               )), '{}'::jsonb))
        from keys k left join per p on p.key = k.key
    $q$, v_view) into v_one using p_store, v_n;
    if coalesce((v_one->>'sampled')::integer, 0) > 0 then
      v_out := v_out || jsonb_build_object(v_view, v_one);
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.abo_store_profile(uuid, text[], integer) from public, anon;
grant execute on function public.abo_store_profile(uuid, text[], integer) to authenticated;

-- The Agents screen counts Scout as it counts the reviewers: by the step it
-- tells (lists read), code with no dollars. Otherwise as 0186.
create or replace function public.abo_admin_agents(p_days integer default 7, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 365));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return (
    with t as (
      select tr.id, tr.road, tr.repairs, tr.took_ms, tr.plan_goal, tr.usage,
             tr.critic->>'verdict' as verdict,
             case when tr.critic->>'missing' ~ '^\d+$' then (tr.critic->>'missing')::integer end as missing,
             tr.unmet <> '[]'::jsonb as unmet,
             tr.steps @> '[{"step": "plan"}]' as planned,
             tr.steps @> '[{"step": "checked"}]' as checked,
             tr.steps @> '[{"step": "gaps"}]' as gapped,
             (select max((s->>'attempt')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'model' and s->>'attempt' ~ '^\d+$') as attempts,
             -- The reviewers after the critic, as their steps told them.
             (select max((s->>'ideas')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'ops' and s->>'ideas' ~ '^\d+$') as ops_ideas,
             tr.steps @> '[{"step": "simplicity"}]' as simple_ran,
             tr.steps @> '[{"step": "simplicity", "verdict": "redo"}]' as simple_redo,
             tr.steps @> '[{"step": "data"}]' as data_ran,
             (select max((s->>'problems')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'data' and s->>'problems' ~ '^\d+$') as data_problems,
             tr.steps @> '[{"step": "dryrun"}]' as dry_ran,
             (select sum((s->>'rules')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'dryrun' and s->>'rules' ~ '^\d+$') as dry_rules,
             tr.steps @> '[{"step": "ux", "verdict": "pass"}]'
               or tr.steps @> '[{"step": "ux", "verdict": "redo"}]' as ux_ran,
             tr.steps @> '[{"step": "ux", "verdict": "redo"}]' as ux_redo,
             tr.steps @> '[{"step": "ux", "how": "screenshot"}]' as ux_shot,
             tr.steps @> '[{"step": "tryout"}]' as tried_out,
             tr.steps @> '[{"step": "scout"}]' as scouted,
             (select max((s->>'lists')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'scout' and s->>'lists' ~ '^\d+$') as scout_lists,
             (select sum((s->>'tried')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'tryout' and s->>'tried' ~ '^\d+$') as tryout_parts,
             (select max((s->>'problems')::integer)
                from jsonb_array_elements(case when jsonb_typeof(tr.steps) = 'array' then tr.steps else '[]'::jsonb end) s
               where s->>'step' = 'tryout' and s->>'problems' ~ '^\d+$') as tryout_problems,
             m.payload->>'type' as ended
        from public.turn_traces tr
        left join public.messages m on m.id = tr.turn_id
       where tr.created_at > v_since
         and (v_scope is null or tr.project_id = any(v_scope))
    ),
    f as (
      select r.detail->>'ai' as state,
             coalesce(jsonb_array_length(case when jsonb_typeof(r.detail->'filled') = 'array' then r.detail->'filled' end), 0) as filled,
             case when jsonb_typeof(r.detail->'usd') = 'number' then (r.detail->>'usd')::numeric end as usd,
             case when jsonb_typeof(r.detail->'input') = 'number' then (r.detail->>'input')::bigint else 0 end as input,
             case when jsonb_typeof(r.detail->'output') = 'number' then (r.detail->>'output')::bigint else 0 end as output
        from public.automation_runs r
        join public.automations au on au.id = r.automation_id
        join public.modules mo on mo.id = au.module_id
       where r.created_at > v_since and r.detail ? 'ai'
         and (v_scope is null or mo.project_id = any(v_scope))
    ),
    -- A job is its agent, but for the two whose job has another name.
    cost as (
      select x.agent, count(distinct x.id) as turns, sum(x.calls) as calls,
             sum(x.input) as input, sum(x.output) as output, sum(x.usd) as usd
        from (select t.id,
                     case when u->>'job' = 'review' then 'simplicity'
                          when u->>'job' = 'ux' then 'screen check'
                          when u->>'job' <> 'reply' then u->>'job'
                          when t.road = 'design' then 'design' else 'talk' end as agent,
                     coalesce((u->>'calls')::bigint, 0) as calls,
                     coalesce((u->>'input')::bigint, 0) as input,
                     coalesce((u->>'output')::bigint, 0) as output,
                     coalesce((u->>'usd')::numeric, 0) as usd
                from t, jsonb_array_elements(case when jsonb_typeof(t.usage->'uses') = 'array'
                                                  then t.usage->'uses' else '[]'::jsonb end) u) x
       group by x.agent
      union all
      select 'ai step', count(*), count(*) filter (where state <> 'running'),
             sum(input), sum(output), coalesce(sum(usd), 0)
        from f
    ),
    -- Each run of the reflector, as it wrote itself down.
    l as (
      select case when jsonb_typeof(o->'created') = 'number' then (o->>'created')::numeric else 0 end as created,
             case when jsonb_typeof(o->'patched') = 'number' then (o->>'patched')::numeric else 0 end as patched,
             case when jsonb_typeof(o->'retired') = 'number' then (o->>'retired')::numeric else 0 end as retired,
             case when jsonb_typeof(o->'repeats') = 'number' then (o->>'repeats')::numeric else 0 end as repeats,
             case when jsonb_typeof(detail->'usd') = 'number' then (detail->>'usd')::numeric end as usd,
             detail->'partial' = 'true'::jsonb as unpriced
        from (select detail, detail->'outcome' as o from public.luke_learning_events
               where event = 'reflected' and at > v_since
                 and (v_scope is null or project_id = any(v_scope))) r
    ),
    j as (
      select case when jsonb_typeof(judge->'addresses') = 'number' then (judge->>'addresses')::numeric end as addresses, ms
        from public.judgements where created_at > v_since
         and (v_scope is null or project_id = any(v_scope))
    ),
    -- runs, calls, usd null: the meter's (the turns with a call of that job, their calls, their dollars).
    a (ord, name, about, runs, outcomes, note, calls, usd) as (
      select 0, 'scout', 'Reads the store field by field before Luke designs: every list''s exact fields, how full each is, the values it holds',
             count(*) filter (where scouted),
             jsonb_build_object('read', count(*) filter (where scouted)),
             coalesce(round(avg(scout_lists) filter (where scouted), 1), 0) || ' store lists a turn; code, no model',
             0, null::numeric
        from t
      union all
      select 1, 'plan', 'Reads the owner''s words before a design and says the goal it understood',
             count(*) filter (where planned),
             jsonb_build_object('understood', count(*) filter (where planned and plan_goal is not null),
                                'no goal', count(*) filter (where planned and plan_goal is null)),
             null::text, null::bigint, null::numeric
        from t
      union all
      select 2, 'design', 'Writes the sections, fields and rules on the design road',
             count(*) filter (where road = 'design'),
             jsonb_build_object('designed', count(*) filter (where road = 'design' and ended in ('plans', 'blueprint')),
                                'asked back', count(*) filter (where road = 'design' and ended = 'clarify'),
                                'answered', count(*) filter (where road = 'design' and ended = 'answer'),
                                'failed', count(*) filter (where road = 'design' and ended = 'unanswered')),
             round(avg(attempts) filter (where road = 'design'), 1) || ' model tries a design',
             null, null
        from t
      union all
      select 3, 'validator', 'Checks a design against what the app can build, and sends it back to be repaired',
             count(*) filter (where checked or repairs > 0),
             jsonb_build_object('passed', count(*) filter (where checked and repairs = 0),
                                'repaired', count(*) filter (where repairs > 0)),
             round(avg(repairs) filter (where repairs > 0), 1) || ' repairs a repaired design',
             0, null
        from t
      union all
      select 4, 'critic', 'Reads the design against what was asked: it fits, or it goes back once',
             count(*) filter (where verdict is not null),
             jsonb_build_object('fits', count(*) filter (where verdict = 'fits'),
                                'redo', count(*) filter (where verdict = 'redo')),
             round(avg(missing) filter (where verdict = 'redo'), 1) || ' parts missing a redo',
             null, null
        from t
      union all
      select 5, 'ops', 'Reads the request as the one who runs the store would, and offers what would help',
             count(*) filter (where ops_ideas is not null),
             jsonb_build_object('idea', count(*) filter (where ops_ideas > 0),
                                'none', count(*) filter (where ops_ideas = 0)),
             null, null, null
        from t
      union all
      select 6, 'simplicity', 'Reads a design for parts the owner does not need: simple, or it goes back once',
             count(*) filter (where simple_ran),
             jsonb_build_object('simple', count(*) filter (where simple_ran and not simple_redo),
                                'redo', count(*) filter (where simple_redo)),
             null, null, null
        from t
      union all
      select 7, 'data check', 'Checks the values and fields a design leans on against the store''s own rows',
             count(*) filter (where data_ran),
             jsonb_build_object('problems found', count(*) filter (where data_ran and data_problems > 0),
                                'clean', count(*) filter (where data_ran and coalesce(data_problems, 0) = 0)),
             'code, no model',
             0, null
        from t
      union all
      select 8, 'dry-run', 'Runs each new rule in the head over the rows it would meet, and counts them',
             count(*) filter (where dry_ran),
             jsonb_build_object('tried', count(*) filter (where dry_ran and dry_rules > 0)),
             coalesce(sum(dry_rules) filter (where dry_ran), 0) || ' rules tried; code, no model',
             0, null
        from t
      union all
      select 9, 'screen check', 'Looks at the screen a design makes, and sends it back once when it would confuse',
             count(*) filter (where ux_ran),
             jsonb_build_object('pass', count(*) filter (where ux_ran and not ux_redo),
                                'redo', count(*) filter (where ux_redo)),
             round(100.0 * count(*) filter (where ux_ran and ux_shot) / nullif(count(*) filter (where ux_ran), 0))
               || '% by screenshot, '
               || round(100.0 * count(*) filter (where ux_ran and not ux_shot) / nullif(count(*) filter (where ux_ran), 0))
               || '% by text',
             null, null
        from t
      union all
      select 10, 'tryout', 'Tries each part of a design on the store''s own rows, and plays the owner''s day through it',
             count(*) filter (where tried_out),
             jsonb_build_object('clean', count(*) filter (where tried_out and coalesce(tryout_problems, 0) = 0),
                                'problems found', count(*) filter (where tried_out and tryout_problems > 0)),
             coalesce(sum(tryout_parts) filter (where tried_out), 0) || ' parts tried; code, and a model for the owner''s day',
             null, null
        from t
      union all
      select 11, 'gap', 'Names what the owner asked for that the design leaves out',
             count(*) filter (where gapped),
             jsonb_build_object('found missing', count(*) filter (where gapped and unmet),
                                'nothing missing', count(*) filter (where gapped and not unmet)),
             null, null, null
        from t
      union all
      -- Notes written by one run share their moment, so a run is a project and a moment.
      select 12, 'memory', 'Writes down facts about the business after a turn',
             count(distinct (project_id, created_at)),
             jsonb_build_object('notes written', count(*)),
             'Runs after the reply, outside the meter: counted by the runs that wrote a note',
             null, null
        from public.merchant_notes where created_at > v_since
         and (v_scope is null or project_id = any(v_scope))
      union all
      select 13, 'reflect', 'Turns what went right and wrong into lessons and skills, and patches or retires them',
             count(*),
             jsonb_build_object('created', coalesce(sum(created), 0), 'patched', coalesce(sum(patched), 0),
                                'retired', coalesce(sum(retired), 0), 'repeats', coalesce(sum(repeats), 0)),
             case when count(*) filter (where unpriced) > 0
                  then count(*) filter (where unpriced) || ' with a call of no known price, so the dollars are short' end,
             count(*), sum(usd)
        from l
      union all
      select 14, 'judge', 'A second opinion on each design after the reply: does it do what was asked',
             count(*),
             jsonb_build_object('addresses', count(*) filter (where addresses >= 0.4),
                                'misses', count(*) filter (where addresses < 0.4)),
             round(avg(ms)) || ' ms a judgement',
             count(*), null
        from j
      union all
      select 15, 'ai step', 'Reads a row''s own words in a rule and fills its other fields: a choice, or a value the words name',
             count(*),
             jsonb_build_object('filled', count(*) filter (where state = 'filled' and filled > 0),
                                'nothing to fill', count(*) filter (where state = 'filled' and filled = 0),
                                'failed', count(*) filter (where state = 'failed')),
             'Runs in rules, outside any turn, on a small model; 200 a store a day',
             null, null
        from f
    )
    select jsonb_build_object(
      'since', v_since,
      'agents', (
        select jsonb_agg(x.card order by x.ord, x.name)
          from (select a.ord, a.name,
                       jsonb_build_object(
                         'name', a.name, 'about', a.about,
                         'runs', coalesce(a.runs, c.turns, 0),
                         'outcomes', a.outcomes, 'note', a.note,
                         'calls', coalesce(a.calls, c.calls, 0),
                         'input', coalesce(c.input, 0), 'output', coalesce(c.output, 0),
                         'usd', coalesce(a.usd, c.usd)) as card
                  from a left join cost c on c.agent = a.name
                union all
                -- A model job no card counts: a card of its own under the job's
                -- name, so a new agent shows the day it first runs.
                select 100, c.agent,
                       jsonb_build_object(
                         'name', c.agent, 'about', null, 'runs', c.turns, 'outcomes', '{}'::jsonb, 'note', null,
                         'calls', coalesce(c.calls, 0), 'input', coalesce(c.input, 0), 'output', coalesce(c.output, 0),
                         'usd', c.usd)
                  from cost c
                 where not exists (select 1 from a where a.name = c.agent)) x),
      'roads', (
        select coalesce(jsonb_agg(jsonb_build_object('road', r.road, 'turns', r.turns, 'p50_ms', r.p50, 'p90_ms', r.p90)
                                  order by r.turns desc), '[]'::jsonb)
          from (select road, count(*) as turns,
                       round(percentile_cont(0.5) within group (order by took_ms))::integer as p50,
                       round(percentile_cont(0.9) within group (order by took_ms))::integer as p90
                  from t where road is not null group by road) r)));
end $$;
revoke all on function public.abo_admin_agents(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_agents(integer, uuid, uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
