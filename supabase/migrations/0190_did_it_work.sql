-- Did it work? (6 Oct.) Two ways a design that was valid but not what
-- was meant gets found out, by people rather than by another model.
--
-- The owner's follow-up: a build three or more days old whose sections
-- nobody has used since (no row added, no rule run, by the same test
-- What stuck uses, 0181) is asked about once, in the bell of whoever
-- asked for it: was it fine, or not what they meant. The answer is kept
-- (build_followups); "not what I meant" opens Luke on that design.
--
-- The judge, checked: an administrator marks recent judged designs right
-- or wrong (judgement_labels), and the owner's own answer counts as a
-- mark too. How often the judge (0082) agrees with people decides whether
-- it may ever send a design back.
--
-- Callers: src/components/AppShell.tsx and ChatPanel.tsx (the bell),
-- src/app/api/mcp/route.ts (pending_changes lists them),
-- src/app/[gate]/judge/page.tsx (labels and agreement).

create table if not exists public.build_followups (
  build_id    uuid primary key references public.messages(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  answer      text not null check (answer in ('fine', 'missed')),
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz not null default now()
);
create index if not exists build_followups_by_project on public.build_followups (project_id, answered_at desc);

alter table public.build_followups enable row level security;
drop policy if exists build_followups_read on public.build_followups;
create policy build_followups_read on public.build_followups
  for select to authenticated using (public.abo_can_use(project_id));
-- No write of the table itself: abo_answer_follow_up is the way in.
drop policy if exists build_followups_oauth_no_insert on public.build_followups;
create policy build_followups_oauth_no_insert on public.build_followups
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists build_followups_oauth_no_update on public.build_followups;
create policy build_followups_oauth_no_update on public.build_followups
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists build_followups_oauth_no_delete on public.build_followups;
create policy build_followups_oauth_no_delete on public.build_followups
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

create table if not exists public.judgement_labels (
  judgement_id uuid primary key references public.judgements(id) on delete cascade,
  is_right     boolean not null,
  labelled_by  uuid references auth.users(id) on delete set null,
  labelled_at  timestamptz not null default now()
);
alter table public.judgement_labels enable row level security;
drop policy if exists judgement_labels_read on public.judgement_labels;
create policy judgement_labels_read on public.judgement_labels
  for select to authenticated using (public.abo_is_superadmin());
drop policy if exists judgement_labels_oauth_no_insert on public.judgement_labels;
create policy judgement_labels_oauth_no_insert on public.judgement_labels
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists judgement_labels_oauth_no_update on public.judgement_labels;
create policy judgement_labels_oauth_no_update on public.judgement_labels
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists judgement_labels_oauth_no_delete on public.judgement_labels;
create policy judgement_labels_oauth_no_delete on public.judgement_labels
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- The builds waiting on the caller's word: theirs (they asked for them,
-- or own the app when nobody is named), three to thirty days old, still
-- there, used by nobody since, and not yet answered. The newest three: a
-- bell of old questions is a bell nobody opens.
create or replace function public.abo_follow_ups(p_project uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (
    select m.id, c.id as conversation_id, c.title,
           coalesce(case when (m.payload ->> 'finished_at') ~ '^\d{4}-'
                         then (m.payload ->> 'finished_at')::timestamptz end, m.created_at) as done_at,
           array(select jsonb_array_elements_text(m.payload -> 'made'))::uuid[] as made
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      join public.projects p on p.id = c.project_id
     where c.project_id = p_project
       and public.abo_can_use(p_project)
       and coalesce(c.created_by, p.owner_id) = auth.uid()
       and m.payload ->> 'type' = 'build' and m.payload ->> 'status' = 'built'
       and jsonb_typeof(m.payload -> 'made') = 'array' and jsonb_array_length(m.payload -> 'made') > 0
       and m.created_at between now() - interval '30 days' and now() - interval '3 days'
       and not exists (select 1 from public.build_followups f where f.build_id = m.id)
  ),
  unused as (
    select b.* from b
     where exists (select 1 from public.modules mo where mo.id = any(b.made))
       and not exists (select 1 from public.records r
                        where r.module_id = any(b.made) and r.created_at > b.done_at)
       and not exists (select 1 from public.automation_runs ar
                         join public.automations a on a.id = ar.automation_id
                        where a.module_id = any(b.made) and ar.created_at > b.done_at)
     order by b.done_at desc
     limit 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'build_id', u.id,
           'built_at', u.done_at,
           'conversation_id', u.conversation_id,
           'title', u.title,
           'sections', (select coalesce(jsonb_agg(mo.nav_label order by mo.sort_order), '[]'::jsonb)
                          from public.modules mo where mo.id = any(u.made)))
         order by u.done_at desc), '[]'::jsonb)
    from unused u
$$;
revoke all on function public.abo_follow_ups(uuid) from public, anon;
grant execute on function public.abo_follow_ups(uuid) to authenticated;

-- The caller's answer about a build of theirs, once.
create or replace function public.abo_answer_follow_up(p_build uuid, p_answer text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_asker   uuid;
begin
  if p_answer is null or p_answer not in ('fine', 'missed') then
    raise exception 'An answer is fine or missed.' using errcode = '22023';
  end if;
  select c.project_id, coalesce(c.created_by, p.owner_id) into v_project, v_asker
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.projects p on p.id = c.project_id
   where m.id = p_build and m.payload ->> 'type' = 'build';
  if v_project is null or not public.abo_can_use(v_project) or v_asker is distinct from auth.uid() then
    raise exception 'Not a build of yours.' using errcode = '42501';
  end if;
  insert into public.build_followups (build_id, project_id, answer, answered_by)
  values (p_build, v_project, p_answer, auth.uid())
  on conflict (build_id) do nothing;
  return found;
end $$;
revoke all on function public.abo_answer_follow_up(uuid, text) from public, anon;
grant execute on function public.abo_answer_follow_up(uuid, text) to authenticated;

-- An administrator's mark on a judged design: right, wrong, or taken back (null).
create or replace function public.abo_admin_judge_label(p_judgement uuid, p_right boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  if p_right is null then
    delete from public.judgement_labels where judgement_id = p_judgement;
  else
    insert into public.judgement_labels (judgement_id, is_right, labelled_by)
    values (p_judgement, p_right, auth.uid())
    on conflict (judgement_id) do update
      set is_right = excluded.is_right, labelled_by = excluded.labelled_by, labelled_at = now();
  end if;
end $$;
revoke all on function public.abo_admin_judge_label(uuid, boolean) from public, anon;
grant execute on function public.abo_admin_judge_label(uuid, boolean) to authenticated;

-- The judged designs to mark, newest first, each with the judge's word and
-- people's (an administrator's mark, else the owner's follow-up), and how
-- often the judge agreed with people: its "does it do what was asked" at
-- 0.4 or more against right, below against wrong.
create or replace function public.abo_admin_judge_queue(
  p_limit integer default 40, p_account uuid default null, p_app uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_scope uuid[] := public.abo_admin_scope(p_account, p_app);
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return (
    with j as (
      select jg.id, jg.created_at, jg.source, jg.request, jg.built, jg.unmet, jg.project_id,
             case when jsonb_typeof(jg.judge -> 'addresses') = 'number'
                  then (jg.judge ->> 'addresses')::numeric end as addresses,
             l.is_right as marked,
             (select f.answer from public.messages bm
                join public.build_followups f on f.build_id = bm.id
               where bm.payload ->> 'type' = 'build' and bm.payload ->> 'design' = jg.ref::text
               limit 1) as owner_said
        from public.judgements jg
        left join public.judgement_labels l on l.judgement_id = jg.id
       where v_scope is null or jg.project_id = any(v_scope)
    ),
    people as (
      select j.*, coalesce(j.marked, case j.owner_said when 'fine' then true when 'missed' then false end) as human
        from j
    )
    select jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'at', x.created_at, 'source', x.source, 'request', x.request, 'built', x.built,
                 'unmet', x.unmet, 'addresses', x.addresses, 'marked', x.marked, 'owner_said', x.owner_said,
                 'project', (select p.name from public.projects p where p.id = x.project_id))
               order by x.created_at desc)
          from (select * from people order by created_at desc
                limit least(greatest(coalesce(p_limit, 40), 1), 200)) x), '[]'::jsonb),
      'agreement', (
        select jsonb_build_object(
                 'judged', count(*) filter (where addresses is not null),
                 'marked', count(*) filter (where human is not null and addresses is not null),
                 'agree', count(*) filter (where human is not null and addresses is not null
                                             and (addresses >= 0.4) = human),
                 'judge_yes_people_no', count(*) filter (where human = false and addresses >= 0.4),
                 'judge_no_people_yes', count(*) filter (where human = true and addresses < 0.4))
          from people)));
end $$;
revoke all on function public.abo_admin_judge_queue(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_judge_queue(integer, uuid, uuid) to authenticated;

-- The Agents screen counts the follow-up by the answers it got. Otherwise as 0189.
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
      union all
      -- The owner's word on a build nobody used (0190): asked once, kept.
      select 16, 'follow-up', 'Asks the owner about a build nobody has used since: fine, or not what they meant',
             count(*),
             jsonb_build_object('fine', count(*) filter (where fu.answer = 'fine'),
                                'not what they meant', count(*) filter (where fu.answer = 'missed')),
             'code, no model: counted by the answers',
             0, null::numeric
        from public.build_followups fu
       where fu.answered_at > v_since
         and (v_scope is null or fu.project_id = any(v_scope))
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
