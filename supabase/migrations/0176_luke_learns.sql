-- Migration 0176: Luke learns
--
-- What Luke knows (0131) is facts about a business. This is what Luke
-- learns about doing the work for it: a lesson is a mistake not to make
-- again, or the owner's own way of doing a thing; a skill is a way of
-- building something that worked. A reflector writes them after a turn,
-- the turns after read the ones that fit, and every use, help, harm and
-- mistake made again is a line on a timeline, so whether learning helps
-- is a number and not a feeling. The owner's thumbs on a reply are the
-- plainest signal of all, and are kept beside them.
--
--   luke_skills            what was learned, per project; thirty active at most
--   luke_learning_events   what happened to each, append-only; and each time
--                          the reflector ran, what it kept and what it cost
--   reply_feedback         an owner's up or down on one reply, with a note
--   abo_admin_learning, abo_admin_learning_project
--                          the console's Learning screen
--   abo_admin_agents       the console's Agents screen: how each of Luke's
--                          agents did, from the traces (0132) and the timeline
--
-- No grants are written: like merchant_notes (0131), the tables take the
-- schema's default privileges, and their policies decide who sees a row.

-- ── What Luke learned ────────────────────────────────────────
create table if not exists public.luke_skills (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  -- lesson: a mistake not to repeat, or the owner's way; skill: a procedure that worked.
  kind                   text not null check (kind in ('lesson', 'skill')),
  title                  text not null check (char_length(title) between 3 and 120),
  when_to_use            text not null default '' check (char_length(when_to_use) <= 300),
  body                   text not null check (char_length(body) between 3 and 1500),
  status                 text not null default 'active' check (status in ('active', 'retired', 'struck')),
  version                integer not null default 1,
  uses                   integer not null default 0,
  helped                 integer not null default 0,
  hurt                   integer not null default 0,
  -- No foreign key: a deleted thread keeps its lesson.
  source_conversation_id uuid,
  source_turn_id         uuid,
  created_by             text not null default 'reflector' check (created_by in ('reflector', 'owner')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_used_at           timestamptz
);
-- One active lesson of a name per project: the same lesson again is a patch to the first.
create unique index if not exists luke_skills_active_title
  on public.luke_skills (project_id, lower(title)) where status = 'active';
create index if not exists luke_skills_project_newest
  on public.luke_skills (project_id, status, updated_at desc);

-- ── What happened to it ──────────────────────────────────────
create table if not exists public.luke_learning_events (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  skill_id        uuid references public.luke_skills(id) on delete set null,
  event           text not null check (event in ('created', 'patched', 'used', 'helped', 'hurt', 'retired', 'struck', 'repeat', 'reflected')),
  -- {"reason": "..."}, or {"before": {...}, "after": {...}} for a patch.
  -- 'reflected' is one run of the reflector, kept or not, with no lesson:
  -- {"why": "...", "outcome": {"created": n, "patched": n, "retired": n,
  -- "repeats": n}, "model": "...", "usd": n or null, "partial": bool}. It
  -- runs after the turn is priced, so its cost is here and not in the trace.
  detail          jsonb not null default '{}'::jsonb,
  conversation_id uuid,
  turn_id         uuid,
  at              timestamptz not null default now()
);
create index if not exists luke_learning_events_project_newest on public.luke_learning_events (project_id, at desc);
create index if not exists luke_learning_events_newest on public.luke_learning_events (at desc);

-- ── What the owner thought of a reply ────────────────────────
create table if not exists public.reply_feedback (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  verdict    text not null check (verdict in ('up', 'down')),
  note       text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  -- One verdict a person a reply: changing their mind is an update.
  unique (message_id, user_id)
);
-- The console reads a project's newest, and a project's delete reaches them by it.
create index if not exists reply_feedback_project_newest on public.reply_feedback (project_id, created_at desc);

-- ── Who may read and write them ──────────────────────────────
alter table public.luke_skills enable row level security;
alter table public.luke_learning_events enable row level security;
alter table public.reply_feedback enable row level security;

-- The owner's, as what Luke knows has been since 0140: learned from the
-- owner's own turns, read into the owner's own designs, struck by the
-- owner. The writer is the server on the owner's client, so the same
-- policy covers the write. A teammate's turn reads none of it.
drop policy if exists luke_skills_owner_all on public.luke_skills;
create policy luke_skills_owner_all on public.luke_skills
  for all to authenticated
  using (public.abo_owns(project_id))
  with check (public.abo_owns(project_id));

drop policy if exists luke_learning_events_owner_all on public.luke_learning_events;
create policy luke_learning_events_owner_all on public.luke_learning_events
  for all to authenticated
  using (public.abo_owns(project_id))
  with check (public.abo_owns(project_id));

-- A person's own verdicts only, in a project they may use.
drop policy if exists reply_feedback_own on public.reply_feedback;
create policy reply_feedback_own on public.reply_feedback
  for all to authenticated
  using (user_id = auth.uid() and public.abo_can_use(project_id))
  with check (user_id = auth.uid() and public.abo_can_use(project_id));

-- And a verdict is on a reply of that project: a message id from
-- somewhere else, filed under a project the person may use, would put a
-- stranger's reply on that project's page.
drop policy if exists reply_feedback_same_project_insert on public.reply_feedback;
create policy reply_feedback_same_project_insert on public.reply_feedback
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                       where m.id = message_id and c.project_id = reply_feedback.project_id));
drop policy if exists reply_feedback_same_project_update on public.reply_feedback;
create policy reply_feedback_same_project_update on public.reply_feedback
  as restrictive for update to authenticated
  with check (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                       where m.id = message_id and c.project_id = reply_feedback.project_id));

-- And the wall every table has, whatever else it has: no write from a
-- connected client's token (check-rls asks abo_tables_missing_oauth_guard).
drop policy if exists luke_skills_oauth_no_insert on public.luke_skills;
create policy luke_skills_oauth_no_insert on public.luke_skills
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists luke_skills_oauth_no_update on public.luke_skills;
create policy luke_skills_oauth_no_update on public.luke_skills
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists luke_skills_oauth_no_delete on public.luke_skills;
create policy luke_skills_oauth_no_delete on public.luke_skills
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists luke_learning_events_oauth_no_insert on public.luke_learning_events;
create policy luke_learning_events_oauth_no_insert on public.luke_learning_events
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists luke_learning_events_oauth_no_update on public.luke_learning_events;
create policy luke_learning_events_oauth_no_update on public.luke_learning_events
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists luke_learning_events_oauth_no_delete on public.luke_learning_events;
create policy luke_learning_events_oauth_no_delete on public.luke_learning_events
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists reply_feedback_oauth_no_insert on public.reply_feedback;
create policy reply_feedback_oauth_no_insert on public.reply_feedback
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists reply_feedback_oauth_no_update on public.reply_feedback;
create policy reply_feedback_oauth_no_update on public.reply_feedback
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists reply_feedback_oauth_no_delete on public.reply_feedback;
create policy reply_feedback_oauth_no_delete on public.reply_feedback
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── Thirty at most ───────────────────────────────────────────
-- What a turn is read stays a page, not a diary: past thirty active, the
-- weakest go (helped minus hurt, then the longest untouched), each said
-- on the timeline. The one just learned is never among them: a lesson
-- has not had its chance before it is first used.
create or replace function public.luke_skills_keep_best()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  with gone as (
    update public.luke_skills s
       set status = 'retired', updated_at = now()
     where s.id in (
       select id from public.luke_skills
        where project_id = new.project_id and status = 'active' and id <> new.id
        order by helped - hurt desc, updated_at desc, id desc
       offset 29
     )
    returning s.id, s.project_id
  )
  insert into public.luke_learning_events (project_id, skill_id, event, detail)
  select project_id, id, 'retired', '{"reason": "cap"}'::jsonb from gone;
  return null;
end $$;
revoke execute on function public.luke_skills_keep_best() from public, anon, authenticated;
drop trigger if exists luke_skills_keep_best on public.luke_skills;
create trigger luke_skills_keep_best
  after insert on public.luke_skills
  for each row when (new.status = 'active')
  execute function public.luke_skills_keep_best();

-- ── The console: Learning ────────────────────────────────────
-- Over the last p_days (1 to 365): what was learned, used, helped and
-- hurt across every store, each store's own counts, and the lessons
-- many stores learned alike. The active counts are today's.
create or replace function public.abo_admin_learning(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
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
    ),
    f as (
      select project_id, verdict, created_at from public.reply_feedback where created_at > v_since
    ),
    k as (
      select project_id,
             count(*) filter (where status = 'active' and kind = 'skill') as active_skills,
             count(*) filter (where status = 'active' and kind = 'lesson') as active_lessons,
             max(updated_at) as at
        from public.luke_skills group by project_id
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
revoke all on function public.abo_admin_learning(integer) from public, anon;
grant execute on function public.abo_admin_learning(integer) to authenticated;

-- One store: every lesson and skill it has had, the timeline over the
-- last p_days (1 to 365), and the owner's verdicts in the same days.
create or replace function public.abo_admin_learning_project(p_project uuid, p_days integer default 90) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 90), 1), 365));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'project', (select jsonb_build_object('id', p.id, 'name', p.name) from public.projects p where p.id = p_project),
    -- ponytail: the newest 500, all statuses; thirty are active, the rest
    -- retired or struck, and a page of retirees past that says nothing new.
    'skills', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.updated_at desc)
        from (select * from public.luke_skills where project_id = p_project
               order by updated_at desc limit 500) s), '[]'::jsonb),
    -- A patch's version is counted, not trusted to the writer's detail:
    -- each patch is the next one.
    'events', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.at desc)
        from (select e.at, e.event, e.skill_id, s.title, s.kind, e.detail, e.conversation_id,
                     case when e.event = 'patched' and e.skill_id is not null then
                       1 + (select count(*) from public.luke_learning_events p
                             where p.skill_id = e.skill_id and p.event = 'patched' and p.at <= e.at)
                     end as version
                from public.luke_learning_events e
                left join public.luke_skills s on s.id = e.skill_id
               where e.project_id = p_project and e.at > v_since
               order by e.at desc
               limit 300) x), '[]'::jsonb),
    'feedback', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.at desc)
        from (select f.created_at as at, f.verdict, f.note, f.message_id, m.conversation_id
                from public.reply_feedback f
                left join public.messages m on m.id = f.message_id
               where f.project_id = p_project and f.created_at > v_since
               order by f.created_at desc
               limit 100) x), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_learning_project(uuid, integer) from public, anon;
grant execute on function public.abo_admin_learning_project(uuid, integer) to authenticated;

-- ── The console: Agents ──────────────────────────────────────
-- How each of Luke's agents did over the last p_days (1 to 365), read
-- from what the turns left (0132) and the timeline above:
--
--   plan       a turn with a plan step; understood when it said a goal
--   design     a turn on the design road; how it ended (the reply's type)
--   validator  a design the validator spoke on; repaired when sent back
--   critic     a design the critic read; fits or redo
--   gap        a design the gap pass read; whether it found something missing
--   memory     facts written about a business (0131); a run that wrote
--              nothing leaves no trace, and its calls are not metered
--   reflect    each run of the reflector ('reflected'), what it kept, and
--              its own dollars: it runs after the turn is priced
--   judge      the shadow judge (0082); addresses below 0.4 is a miss,
--              the rate that decides whether it ever gates a build
--
-- Calls, tokens and dollars are the meter's (lib/usage.ts), already
-- priced when the turn ended, as Spend reads them: a design's calls are
-- the reply's on the design road, the others their own job. An agent
-- with no metered call has null dollars: the validator is code, and the
-- judge and memory run after the reply, outside the meter. The reflector
-- writes down its own.
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
             m.payload->>'type' as ended
        from public.turn_traces tr
        left join public.messages m on m.id = tr.turn_id
       where tr.created_at > v_since
    ),
    cost as (
      select x.agent, count(distinct x.id) as turns, sum(x.calls) as calls,
             sum(x.input) as input, sum(x.output) as output, sum(x.usd) as usd
        from (select t.id,
                     case when u->>'job' <> 'reply' then u->>'job'
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
      select 5, 'gap', 'Names what the owner asked for that the design leaves out',
             count(*) filter (where gapped),
             jsonb_build_object('found missing', count(*) filter (where gapped and unmet),
                                'nothing missing', count(*) filter (where gapped and not unmet)),
             null, null, null
        from t
      union all
      -- Notes written by one run share their moment, so a run is a project and a moment.
      select 6, 'memory', 'Writes down facts about the business after a turn',
             count(distinct (project_id, created_at)),
             jsonb_build_object('notes written', count(*)),
             'Runs after the reply, outside the meter: counted by the runs that wrote a note',
             null, null
        from public.merchant_notes where created_at > v_since
      union all
      select 7, 'reflect', 'Turns what went right and wrong into lessons and skills, and patches or retires them',
             count(*),
             jsonb_build_object('created', coalesce(sum(created), 0), 'patched', coalesce(sum(patched), 0),
                                'retired', coalesce(sum(retired), 0), 'repeats', coalesce(sum(repeats), 0)),
             case when count(*) filter (where unpriced) > 0
                  then count(*) filter (where unpriced) || ' with a call of no known price, so the dollars are short' end,
             count(*), sum(usd)
        from l
      union all
      select 8, 'judge', 'A second opinion on each design after the reply: does it do what was asked',
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
