-- The console sees one account (5 Oct).
--
-- Every account's data was always its own (RLS), but the console's reports
-- counted everyone together, a date the only thing to narrow them by. Now
-- each takes a scope: an account (its owner's apps, and the team working
-- in them), one app of it, or nobody named for everyone, as before. Asked
-- of the database, so a report of one account counts that account and no
-- other; a call that names nothing reads exactly as it did. The access log
-- also narrows to one administrator, and says who has acted.
--
-- Platform-wide screens (invites, early access, Shopify apps, privacy,
-- evals) take no scope: they belong to no one account.

-- The scope itself, apps and people, is abo_admin_scope and abo_admin_scope_people (0181).

drop function if exists public.abo_admin_spend(integer);
create or replace function public.abo_admin_spend(p_days integer default 30, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_days  integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
                         - make_interval(days => v_days - 1);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return (
    with t as (
      select tt.created_at, tt.usage, p.owner_id,
             coalesce((tt.usage ->> 'usd')::numeric, 0) as usd,
             coalesce((tt.usage ->> 'partial')::boolean, false) as partial
        from public.turn_traces tt
        join public.projects p on p.id = tt.project_id
       where tt.created_at >= v_since
         and (v_scope is null or tt.project_id = any(v_scope))
    ),
    uses as (
      select x ->> 'model' as model, coalesce((x ->> 'usd')::numeric, 0) as usd,
             coalesce((x ->> 'input')::bigint, 0) as input, coalesce((x ->> 'output')::bigint, 0) as output
        from t, jsonb_array_elements(case when jsonb_typeof(t.usage -> 'uses') = 'array'
                                          then t.usage -> 'uses' else '[]'::jsonb end) x
    )
    select jsonb_build_object(
      'since', v_since,
      'total', (select jsonb_build_object('usd', coalesce(sum(usd), 0), 'turns', count(*),
                                          'accounts', count(distinct owner_id),
                                          'partial', count(*) filter (where partial)) from t),
      'days', (select coalesce(jsonb_agg(jsonb_build_object('day', to_char(d at time zone 'utc', 'YYYY-MM-DD'),
                                                            'usd', coalesce(x.usd, 0), 'turns', coalesce(x.turns, 0))
                                         order by d), '[]'::jsonb)
                 from generate_series(v_since, v_since + make_interval(days => v_days - 1), interval '1 day') d
                 left join (select date_trunc('day', created_at at time zone 'utc') at time zone 'utc' as day,
                                   sum(usd) as usd, count(*) as turns
                              from t group by 1) x on x.day = d),
      'models', (select coalesce(jsonb_agg(jsonb_build_object('model', m.model, 'usd', m.usd, 'calls', m.calls,
                                                              'input', m.input, 'output', m.output)
                                           order by m.usd desc), '[]'::jsonb)
                   from (select coalesce(model, 'unknown') as model, sum(usd) as usd, count(*) as calls,
                                sum(input) as input, sum(output) as output
                           from uses group by 1) m),
      'accounts', (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.owner_id, 'email', u.email,
                                                                'usd', a.usd, 'turns', a.turns)
                                             order by a.usd desc), '[]'::jsonb)
                     from (select owner_id, sum(usd) as usd, count(*) as turns
                             from t group by owner_id order by sum(usd) desc limit 20) a
                     left join auth.users u on u.id = a.owner_id),
      'kept_from', (select min(created_at) from public.turn_traces))
  );
end $$;
revoke all on function public.abo_admin_spend(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_spend(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_routing(integer);
create or replace function public.abo_admin_routing(p_days integer default 30, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_days int := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return (
    with t as (
      select tr.road,
             m.payload->>'type' as ended,
             coalesce((tr.usage->>'usd')::numeric, 0) as usd,
             -- Begun on the talk road and handed to the design road (engine.ts).
             tr.road = 'design' and tr.steps::text like '%"road": "talk"%' as handed_back
        from public.turn_traces tr
        left join public.messages m on m.id = tr.turn_id
       where tr.created_at > now() - make_interval(days => v_days) and tr.road is not null
         and (v_scope is null or tr.project_id = any(v_scope))
    )
    select jsonb_build_object(
             'turns', count(*),
             'answered_on_design', count(*) filter (where road = 'design' and ended = 'answer' and not handed_back),
             'handed_back', count(*) filter (where handed_back),
             'wrong_road_usd', round(coalesce(sum(usd) filter (where road = 'design' and ended = 'answer' and not handed_back), 0), 4))
      from t
  );
end $$;
revoke all on function public.abo_admin_routing(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_routing(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_trouble(integer);
create or replace function public.abo_admin_trouble(p_days integer default 7, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x order by x.at desc)
      from (
        select * from (
          -- Luke's turns that went wrong.
          select 'turn' as kind, t.created_at as at, t.project_id, t.conversation_id,
                 case
                   when t.critic->>'verdict' = 'redo' then 'The critic sent the design back'
                   when t.repairs >= 2 then 'Needed ' || t.repairs || ' repairs'
                   else 'The turn failed'
                 end as detail,
                 coalesce(t.plan_goal, left(t.repair_errors->>0, 160)) as sample
            from public.turn_traces t
           where t.created_at > v_since
             and (t.repairs >= 2 or t.critic->>'verdict' = 'redo'
                  or exists (select 1 from public.messages m where m.id = t.turn_id and m.payload->>'type' = 'unanswered'))
          union all
          -- An owner saying it went wrong.
          select 'frustrated', m.created_at, c.project_id, m.conversation_id,
                 'The owner sounds unhappy', left(m.payload->>'text', 200)
            from public.messages m
            join public.conversations c on c.id = m.conversation_id
           where m.role = 'user' and m.created_at > v_since
             and (m.payload->>'text') ~* '(\mwrong\M|not what i|\mdumb\M|still (not|broken|wrong)|doesn.?t work|didn.?t work|\mmessed up\M|why (is|did|does) it|\mgalat\M|phir se|nahi chahiye|kaam nahi|samajh nahi|\mbekar\M)'
          union all
          -- A section changed again and again in a day.
          select 'churn', max(s.created_at), mo.project_id, null::uuid,
                 mo.nav_label || ' changed ' || count(*) || ' times in a day',
                 string_agg(left(coalesce(s.change_description, ''), 60), ' · ' order by s.version)
            from public.ui_schemas s
            join public.modules mo on mo.id = s.module_id
           where s.created_at > v_since
           group by mo.id, mo.project_id, mo.nav_label, date_trunc('day', s.created_at)
          having count(*) >= 4
          union all
          -- A rule failing on its runs.
          select 'rule', f.at, a.project_id, null::uuid,
                 'Rule "' || a.name || '" failed ' || f.n || ' time' || case when f.n = 1 then '' else 's' end,
                 left(f.error, 200)
            from public.automations a
            join lateral (
              select count(*) as n, max(at) as at, max(error) as error from (
                select r.created_at as at, r.detail->>'error' as error from public.automation_runs r
                 where r.automation_id = a.id and not r.ok and r.created_at > v_since
                union all
                select coalesce(j.finished_at, j.created_at), j.error from public.code_jobs j
                 where j.automation_id = a.id and j.status = 'failed' and j.created_at > v_since
              ) e
            ) f on f.n > 0
          union all
          -- A written screen that broke while it ran (0178): its newest
          -- message, and how many times it was told, by screen.
          select 'screen', max(e.at), e.project_id, null::uuid,
                 'The screen "' || e.screen || '" on ' || coalesce(mo.nav_label, 'a section') || ' broke ' || count(*) || ' time' || case when count(*) = 1 then '' else 's' end,
                 left((array_agg(e.message order by e.at desc))[1], 200)
            from public.screen_errors e
            left join public.modules mo on mo.id = e.module_id
           where e.at > v_since
           group by e.project_id, e.module_id, mo.nav_label, e.screen
          union all
          -- A schedule setting fields on every row: a default filled in by hand.
          select 'workaround', a.created_at, a.project_id, null::uuid,
                 'Rule "' || a.name || '" sets fields on every row, every run',
                 left((a.definition->'actions')::text, 200)
            from public.automations a
           where a.created_at > v_since and a.enabled
             and a.definition->'trigger'->>'type' = 'schedule'
             and a.definition->'trigger'->'when' is null
             and a.definition->'actions' @> '[{"type": "set_fields"}]'::jsonb
          union all
          -- Three or more yes/no or status fields sharing a word: one fact kept three ways.
          select 'workaround', w.at, w.project_id, null::uuid,
                 w.nav_label || ' has ' || w.n || ' fields for "' || w.word || '"',
                 w.fields
            from (
              select mo.project_id, mo.nav_label, s.created_at as at, tok.word,
                     count(*) as n, string_agg(col->>'field', ', ') as fields
                from public.modules mo
                join lateral (select * from public.ui_schemas u where u.module_id = mo.id order by u.version desc limit 1) s on true
                cross join lateral jsonb_array_elements(s.schema_json->'columns') col
                cross join lateral regexp_split_to_table(col->>'field', '_') tok(word)
               where s.created_at > v_since
                 and col->>'type' in ('boolean', 'badge', 'dropdown')
                 and length(tok.word) >= 3
                 and tok.word not in ('status', 'state', 'type', 'flag', 'stage', 'kind')
               group by mo.project_id, mo.nav_label, s.created_at, tok.word
              having count(*) >= 3
            ) w
        ) signs
       where v_scope is null or signs.project_id = any(v_scope)
       order by at desc
       limit 100
      ) x0
      cross join lateral (
        select x0.kind, x0.at, x0.detail, x0.sample, x0.conversation_id,
               p.id as project_id, p.name as project,
               (select c.title from public.conversations c where c.id = x0.conversation_id) as title
          from public.projects p where p.id = x0.project_id
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function public.abo_admin_trouble(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_trouble(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_their_ai(integer);
create or replace function public.abo_admin_their_ai(p_days integer default 30, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_people uuid[] := public.abo_admin_scope_people(p_account, p_app);
  v_days  integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
                         - make_interval(days => v_days - 1);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return (
    with c as (
      select created_at, user_id, tool, coalesce(guide, 'before 0180') as guide,
             to_char(date_trunc('week', created_at at time zone 'utc'), 'YYYY-MM-DD') as week,
             outcome, problems
        from public.mcp_calls
       where client_id is not null and created_at >= v_since
         and (v_people is null or user_id = any(v_people))
    ),
    g as (
      select case when grouping(guide) = 0 then 'guide'
                  when grouping(week) = 0 then 'week'
                  when grouping(tool) = 0 then 'tool'
                  else 'all' end as kind,
             coalesce(case when grouping(guide) = 0 then guide
                           when grouping(week) = 0 then week
                           when grouping(tool) = 0 then tool end, 'all') as key,
             count(*) as calls,
             count(*) filter (where tool = 'initialize') as connects,
             count(distinct user_id) as accounts,
             count(*) filter (where tool = 'submit_design') as designs,
             count(*) filter (where tool = 'submit_design' and outcome = 'not accepted') as designs_refused,
             count(*) filter (where tool = 'submit_design' and outcome = 'luke changed it') as designs_luke_changed,
             round(avg(problems) filter (where outcome = 'not accepted' and problems > 0), 1) as problems_per_refusal,
             count(*) filter (where tool = 'validate_design') as checks,
             count(*) filter (where tool = 'propose_change') as luke_asked,
             count(*) filter (where tool = 'edit_view' and outcome is distinct from 'not accepted') as free_edits,
             count(*) filter (where tool = 'undo_build') as undone,
             count(*) filter (where outcome = 'error') as errors,
             min(created_at) as first, max(created_at) as last
        from c
       group by grouping sets ((guide), (week), (tool), ())
    ),
    outcomes as (
      select tool, jsonb_object_agg(coalesce(outcome, 'not read'), n) as by_outcome
        from (select tool, outcome, count(*) as n from c group by 1, 2) x
       group by tool
    )
    select jsonb_build_object(
      'since', v_since,
      'all', (select to_jsonb(g) - 'kind' - 'key' from g where kind = 'all'),
      'guides', (select coalesce(jsonb_agg(to_jsonb(g) - 'kind' order by g.first), '[]'::jsonb) from g where kind = 'guide'),
      'weeks', (select coalesce(jsonb_agg(to_jsonb(g) - 'kind' order by g.key), '[]'::jsonb) from g where kind = 'week'),
      'tools', (select coalesce(jsonb_agg((to_jsonb(g) - 'kind') || jsonb_build_object('outcomes', o.by_outcome)
                                          order by g.calls desc), '[]'::jsonb)
                  from g left join outcomes o on o.tool = g.key where g.kind = 'tool'),
      'requests', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                     from (select status, count(*) as n from public.build_requests
                            where client_id is not null and created_at >= v_since
                              and (v_scope is null or project_id = any(v_scope)) group by 1) r)
    )
  );
end $$;
revoke all on function public.abo_admin_their_ai(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_their_ai(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_agents(integer);
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
             m.payload->>'type' as ended
        from public.turn_traces tr
        left join public.messages m on m.id = tr.turn_id
       where tr.created_at > v_since
         and (v_scope is null or tr.project_id = any(v_scope))
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
revoke all on function public.abo_admin_agents(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_agents(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_learning(integer);
create or replace function public.abo_admin_learning(p_days integer default 30, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return (
    with e as (
      select le.project_id, le.skill_id, le.event, le.at, s.kind,
             case when le.event = 'reflected' and jsonb_typeof(le.detail->'usd') = 'number'
                  then (le.detail->>'usd')::numeric end as usd
        from public.luke_learning_events le
        left join public.luke_skills s on s.id = le.skill_id
       where le.at > v_since
         and (v_scope is null or le.project_id = any(v_scope))
    ),
    f as (
      select project_id, verdict, created_at from public.reply_feedback where created_at > v_since
         and (v_scope is null or project_id = any(v_scope))
    ),
    k as (
      select project_id,
             count(*) filter (where status = 'active' and kind = 'skill') as active_skills,
             count(*) filter (where status = 'active' and kind = 'lesson') as active_lessons,
             max(updated_at) as at
        from public.luke_skills where v_scope is null or project_id = any(v_scope) group by project_id
    ),
    ev as (
      select project_id,
             count(*) filter (where event = 'created') as created,
             count(*) filter (where event = 'used') as used,
             count(*) filter (where event = 'helped') as helped,
             count(*) filter (where event = 'hurt') as hurt,
             count(*) filter (where event = 'repeat') as repeats,
             count(*) filter (where event = 'reflected') as reflections,
             sum(usd) as learning_usd,
             max(at) as at
        from e group by project_id
    ),
    fb as (
      select project_id,
             count(*) filter (where verdict = 'up') as up,
             count(*) filter (where verdict = 'down') as down,
             max(created_at) as at
        from f group by project_id
    ),
    per as (
      select i.project_id, p.name as project,
             coalesce(k.active_skills, 0) as active_skills, coalesce(k.active_lessons, 0) as active_lessons,
             coalesce(ev.created, 0) as created, coalesce(ev.used, 0) as used,
             coalesce(ev.helped, 0) as helped, coalesce(ev.hurt, 0) as hurt, coalesce(ev.repeats, 0) as repeats,
             coalesce(ev.reflections, 0) as reflections, coalesce(ev.learning_usd, 0) as learning_usd,
             coalesce(fb.up, 0) as feedback_up, coalesce(fb.down, 0) as feedback_down,
             greatest(ev.at, fb.at, k.at) as last_at
        from (select project_id from k union select project_id from ev union select project_id from fb) i
        join public.projects p on p.id = i.project_id
        left join k on k.project_id = i.project_id
        left join ev on ev.project_id = i.project_id
        left join fb on fb.project_id = i.project_id
    )
    select jsonb_build_object(
      'totals', (
        select jsonb_build_object(
          'active_skills', (select coalesce(sum(active_skills), 0) from k),
          'active_lessons', (select coalesce(sum(active_lessons), 0) from k),
          'created', count(*) filter (where event = 'created'),
          'patched', count(*) filter (where event = 'patched'),
          'retired', count(*) filter (where event = 'retired'),
          'struck', count(*) filter (where event = 'struck'),
          'used', count(*) filter (where event = 'used'),
          'helped', count(*) filter (where event = 'helped'),
          'hurt', count(*) filter (where event = 'hurt'),
          'repeats', count(*) filter (where event = 'repeat'),
          -- What learning cost: the reflector's runs and their dollars.
          'reflections', count(*) filter (where event = 'reflected'),
          'learning_usd', coalesce(sum(usd), 0),
          -- The share of lessons Luke had in hand that were broken anyway:
          -- mistakes made again, over the lessons read into a turn in the
          -- window. Near nought, lessons work; rising, they are read and
          -- not followed, and need rewording rather than more of them.
          'repeat_rate', round(
            (count(*) filter (where event = 'repeat'))::numeric
              / greatest(1, count(distinct skill_id) filter (where event = 'used' and kind = 'lesson')), 3),
          'feedback_up', (select count(*) from f where verdict = 'up'),
          'feedback_down', (select count(*) from f where verdict = 'down'))
          from e),
      'projects', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.last_at desc nulls last), '[]'::jsonb)
          from (select * from per order by last_at desc nulls last limit 200) x),
      -- One lesson learned in many stores is a lesson for every store.
      'top', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.uses desc, x.projects desc), '[]'::jsonb)
          from (select (array_agg(title order by uses desc))[1] as title,
                       (array_agg(kind order by uses desc))[1] as kind,
                       count(distinct project_id) as projects,
                       sum(uses) as uses, sum(helped) as helped, sum(hurt) as hurt
                  from public.luke_skills
                 where status = 'active'
                 group by lower(title)
                 order by sum(uses) desc, count(distinct project_id) desc
                 limit 20) x)));
end $$;
revoke all on function public.abo_admin_learning(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_learning(integer, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_conversations(text, text, integer, integer, timestamptz);
create or replace function public.abo_admin_conversations(
  p_query  text default null,
  p_filter text default 'recent',
  p_days   integer default 30,
  p_limit  integer default 50,
  p_before timestamptz default null,
  p_account uuid default null,
  p_app    uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_scope  uuid[] := public.abo_admin_scope(p_account, p_app);
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_whole boolean := false;
  v_id    uuid;
  v_out   jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_filter is null or p_filter not in ('recent', 'problems', 'costly', 'slow') then
    raise exception 'No such view.' using errcode = '22023';
  end if;
  -- An id pasted whole: the conversation it is, or the one its message or turn is in.
  if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_whole := true;
    v_id := coalesce(
      (select c.id from public.conversations c where c.id = v_q::uuid),
      (select m.conversation_id from public.messages m where m.id = v_q::uuid),
      (select t.conversation_id from public.turn_traces t where t.turn_id = v_q::uuid limit 1)
    );
  end if;

  with picked as (
    select c.id, c.title, c.project_id, c.created_at, c.updated_at
      from public.conversations c
      join public.projects p on p.id = c.project_id
      left join auth.users u on u.id = p.owner_id
     where case
             when v_whole then c.id = v_id
             else c.updated_at >= v_since
                  and (p_before is null or c.updated_at < p_before)
                  and (v_scope is null or c.project_id = any(v_scope))
                  and (v_q is null
                       or c.title ilike '%' || v_q || '%'
                       or p.name ilike '%' || v_q || '%'
                       or u.email ilike '%' || v_q || '%'
                       or exists (select 1 from public.stores s
                                   where s.project_id = p.id and s.shop_domain ilike '%' || v_q || '%'))
           end
  ),
  agg as (
    select t.conversation_id,
           count(*) as turns,
           coalesce(sum((t.usage ->> 'usd')::numeric), 0) as usd,
           coalesce(sum(tok.input), 0) as input,
           coalesce(sum(tok.output), 0) as output,
           coalesce(max(t.took_ms), 0) as slowest,
           count(*) filter (
             where t.repairs > 0
                or (jsonb_typeof(t.repair_errors) = 'array' and jsonb_array_length(t.repair_errors) > 0)
                or (jsonb_typeof(t.unmet) = 'array' and jsonb_array_length(t.unmet) > 0)
                -- The critic sent it back, or found something it left out.
                or (t.critic ->> 'verdict') = 'redo'
                or coalesce((t.critic ->> 'missing')::integer, 0) > 0
           ) as troubled
      from public.turn_traces t
      left join lateral (
        select sum((x ->> 'input')::bigint) as input, sum((x ->> 'output')::bigint) as output
          from jsonb_array_elements(case when jsonb_typeof(t.usage -> 'uses') = 'array' then t.usage -> 'uses' else '[]'::jsonb end) x
      ) tok on true
     where t.conversation_id in (select id from picked)
     group by t.conversation_id
  )
  select coalesce(jsonb_agg(r.j order by r.n), '[]'::jsonb) into v_out
    from (
      select row_number() over (
               order by case when p_filter = 'costly' then a.usd end desc nulls last,
                        case when p_filter = 'slow' then a.slowest end desc nulls last,
                        c.updated_at desc) as n,
             jsonb_build_object(
               'id', c.id, 'title', c.title, 'created_at', c.created_at, 'updated_at', c.updated_at,
               'project', jsonb_build_object('id', p.id, 'name', p.name),
               'owner', u.email,
               'shop', (select s.shop_domain from public.stores s where s.project_id = p.id
                         order by s.connected_at desc nulls last limit 1),
               'turns', coalesce(a.turns, 0), 'usd', coalesce(a.usd, 0),
               'input', coalesce(a.input, 0), 'output', coalesce(a.output, 0),
               'slowest_ms', coalesce(a.slowest, 0), 'troubled', coalesce(a.troubled, 0)) as j
        from picked c
        join public.projects p on p.id = c.project_id
        left join auth.users u on u.id = p.owner_id
        left join agg a on a.conversation_id = c.id
       where p_filter <> 'problems' or coalesce(a.troubled, 0) > 0
       order by n
       limit v_limit
    ) r;
  return v_out;
end $$;
revoke all on function public.abo_admin_conversations(text, text, integer, integer, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_conversations(text, text, integer, integer, timestamptz, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_access_log(text, text, integer, integer, timestamptz);
create or replace function public.abo_admin_access_log(
  p_query  text default null,
  p_action text default null,
  p_days   integer default 30,
  p_limit  integer default 100,
  p_before timestamptz default null,
  p_account uuid default null,
  p_admin  uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_people uuid[] := public.abo_admin_scope_people(p_account, null);
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 3650));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc)
        from (
          select a.id, a.created_at, a.action, a.old_value, a.new_value,
                 a.actor_user_id as actor_id, ua.email as actor,
                 a.target_user_id as target_id, ut.email as target
            from public.admin_account_audit a
            left join auth.users ua on ua.id = a.actor_user_id
            left join auth.users ut on ut.id = a.target_user_id
           where a.created_at >= v_since
             and (p_before is null or a.created_at < p_before)
             and (p_action is null or a.action = p_action)
             and (p_admin is null or a.actor_user_id = p_admin)
             and (v_people is null or a.target_user_id = any(v_people))
             and (v_q is null or ua.email ilike '%' || v_q || '%' or ut.email ilike '%' || v_q || '%')
           order by a.created_at desc, a.id desc
           limit v_limit
        ) r), '[]'::jsonb),
    -- How often each kind happened in the window, for the filter.
    'actions', coalesce((
      select jsonb_object_agg(x.action, x.n)
        from (select action, count(*) as n from public.admin_account_audit
               where created_at >= v_since group by action) x), '{}'::jsonb),
    -- Who has acted, for the Admin filter.
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.actor_user_id, 'email', u.email) order by u.email)
        from (select distinct actor_user_id from public.admin_account_audit where actor_user_id is not null) x
        left join auth.users u on u.id = x.actor_user_id), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_access_log(text, text, integer, integer, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_access_log(text, text, integer, integer, timestamptz, uuid, uuid) to authenticated;

drop function if exists public.abo_admin_tour_report(integer);
create or replace function public.abo_admin_tour_report(p_limit integer default 200, p_account uuid default null, p_app uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_people uuid[] := public.abo_admin_scope_people(p_account, p_app);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'totals', (
      select jsonb_build_object(
               'shown', count(*),
               'finished', count(*) filter (where outcome = 'finished'),
               'closed', count(*) filter (where outcome = 'closed'),
               'open', count(*) filter (where outcome is null),
               'again', count(*) filter (where times > 1))
        from public.tour_views where v_people is null or user_id = any(v_people)),
    'closed_on', coalesce((
      select jsonb_object_agg(closed_on, n)
        from (select closed_on, count(*) as n from public.tour_views
               where outcome = 'closed' and closed_on is not null
                 and (v_people is null or user_id = any(v_people)) group by closed_on) c), '{}'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', v.user_id, 'email', u.email, 'first_at', v.first_at, 'last_at', v.last_at,
               'times', v.times, 'outcome', v.outcome, 'reached', v.reached, 'stops', v.stops,
               'closed_on', v.closed_on)
               order by v.last_at desc)
        from (select * from public.tour_views where v_people is null or user_id = any(v_people) order by last_at desc
               limit least(greatest(coalesce(p_limit, 200), 1), 1000)) v
        left join auth.users u on u.id = v.user_id), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_tour_report(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_tour_report(integer, uuid, uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
