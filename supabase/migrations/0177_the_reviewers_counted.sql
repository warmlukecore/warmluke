-- Migration 0177: the reviewers counted
--
-- A design now passes more readers after the critic: the operator's view
-- (ideas from the one who runs the store), the simplicity reviewer, the
-- data check (lib/data-check.ts: the values and fields a design leans on,
-- against the store's own rows), the rule dry-run (lib/dry-run.ts: each
-- new rule counted on the rows it would meet) and the screen check. Each
-- tells a step into the turn's trace (0132), and the ones with a model
-- call are metered under their own job. The console's Agents screen
-- (0176) counts them beside the others:
--
--   ops           a turn whose ops step said how many ideas (null: none asked);
--                 idea when it offered one, none when it had none
--   simplicity    a turn with a simplicity step; simple, or redo when it sent
--                 the design back. Its calls are the meter's job 'review'
--   data check    a turn with a data step; problems found, or clean. Code,
--                 no model, so no dollars
--   dry-run       a turn with a dryrun step; tried when it had rules to count,
--                 and how many rules in all. Code, no dollars
--   screen check  a turn with a ux step that looked (not 'skipped'); pass or
--                 redo, and how much of it was by screenshot and how much by
--                 text. Its calls are the meter's job 'ux'
--
-- abo_admin_agents as 0176 wrote it otherwise: the same signature,
-- security, grants and refusal, every agent it had in the same order,
-- the new ones after the critic.

create or replace function public.abo_admin_agents(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
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
             m.payload->>'type' as ended
        from public.turn_traces tr
        left join public.messages m on m.id = tr.turn_id
       where tr.created_at > v_since
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
               where event = 'reflected' and at > v_since) r
    ),
    j as (
      select case when jsonb_typeof(judge->'addresses') = 'number' then (judge->>'addresses')::numeric end as addresses, ms
        from public.judgements where created_at > v_since
    ),
    -- runs, calls, usd null: the meter's (the turns with a call of that job, their calls, their dollars).
    a (ord, name, about, runs, outcomes, note, calls, usd) as (
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
      select 10, 'gap', 'Names what the owner asked for that the design leaves out',
             count(*) filter (where gapped),
             jsonb_build_object('found missing', count(*) filter (where gapped and unmet),
                                'nothing missing', count(*) filter (where gapped and not unmet)),
             null, null, null
        from t
      union all
      -- Notes written by one run share their moment, so a run is a project and a moment.
      select 11, 'memory', 'Writes down facts about the business after a turn',
             count(distinct (project_id, created_at)),
             jsonb_build_object('notes written', count(*)),
             'Runs after the reply, outside the meter: counted by the runs that wrote a note',
             null, null
        from public.merchant_notes where created_at > v_since
      union all
      select 12, 'reflect', 'Turns what went right and wrong into lessons and skills, and patches or retires them',
             count(*),
             jsonb_build_object('created', coalesce(sum(created), 0), 'patched', coalesce(sum(patched), 0),
                                'retired', coalesce(sum(retired), 0), 'repeats', coalesce(sum(repeats), 0)),
             case when count(*) filter (where unpriced) > 0
                  then count(*) filter (where unpriced) || ' with a call of no known price, so the dollars are short' end,
             count(*), sum(usd)
        from l
      union all
      select 13, 'judge', 'A second opinion on each design after the reply: does it do what was asked',
             count(*),
             jsonb_build_object('addresses', count(*) filter (where addresses >= 0.4),
                                'misses', count(*) filter (where addresses < 0.4)),
             round(avg(ms)) || ' ms a judgement',
             count(*), null
        from j
    )
    select jsonb_build_object(
      'since', v_since,
      'agents', (
        select jsonb_agg(jsonb_build_object(
                 'name', a.name, 'about', a.about,
                 'runs', coalesce(a.runs, c.turns, 0),
                 'outcomes', a.outcomes, 'note', a.note,
                 'calls', coalesce(a.calls, c.calls, 0),
                 'input', coalesce(c.input, 0), 'output', coalesce(c.output, 0),
                 'usd', coalesce(a.usd, c.usd))
               order by a.ord)
          from a left join cost c on c.agent = a.name),
      'roads', (
        select coalesce(jsonb_agg(jsonb_build_object('road', r.road, 'turns', r.turns, 'p50_ms', r.p50, 'p90_ms', r.p90)
                                  order by r.turns desc), '[]'::jsonb)
          from (select road, count(*) as turns,
                       round(percentile_cont(0.5) within group (order by took_ms))::integer as p50,
                       round(percentile_cont(0.9) within group (order by took_ms))::integer as p90
                  from t where road is not null group by road) r)));
end $$;
revoke all on function public.abo_admin_agents(integer) from public, anon;
grant execute on function public.abo_admin_agents(integer) to authenticated;

NOTIFY pgrst, 'reload schema';
