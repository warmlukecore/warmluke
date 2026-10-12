-- Migration 0211: what went wrong is kept
--
-- Tanish's first meeting (a57134fd, 11 Oct) went wrong for two hours, and we
-- learned of it from their bug reports the next day:
--   - five builds in one conversation;
--   - Luke saying "I can't see your custom rows";
--   - rules that never ran;
--   - an owner calling Luke stupid;
--   - design turns of three to five minutes.
-- 0175's "Needs a look" saw almost none of it: no slow turns, no "I can't",
-- no rebuilds (the section was deleted and remade, so per-section churn
-- missed it), no rules that never ran or changed nothing, no asks left
-- undone, no turn stopped, no owner left mid-plan, and its words missed
-- "why would I lie" and a lone "?".
--
-- So the signs are now found by a scan and kept, one row each, keyed so a
-- scan run twice keeps one:
--   - pg_cron runs it every fifteen minutes where it exists, and Needs a look
--     runs it before it reads, so any database is fresh;
--   - a superadmin sees yesterday's, worst first, on opening the console;
--   - the email digest, when custom SMTP comes, reads the same rows.
--
--   trouble_signs        one per sign: kind, when, project, conversation, the
--                        turn (a message id), what and a sample, a weight.
--                        Read only through the superadmin functions.
--   trouble_scan         where the last scan got to.
--   abo_trouble_scan     finds what is new since then (two hours back, for
--                        late rows) and keeps it. Internal.
--   abo_admin_trouble    0184's, now reading what was kept, with the turn and
--                        the weight.
--   abo_admin_trouble_day yesterday in the console's zone: how many, by kind,
--                        and the conversations that went worst.
--
-- The words for "Luke says he can't" and "the owner is unhappy" are also in
-- scripts/autopsy.mjs: change both.
--
-- ponytail: words matched by a list, not understood. A cheap judge over
-- owner messages the list misses is the upgrade (Haiku, about $0.06 a day
-- at 200 messages).

create table if not exists public.trouble_signs (
  key             text primary key,
  kind            text not null,
  at              timestamptz not null,
  project_id      uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  turn_id         uuid,
  detail          text not null,
  sample          text,
  weight          smallint not null default 1,
  created_at      timestamptz not null default now()
);
create index if not exists trouble_signs_at on public.trouble_signs (at desc);
create index if not exists trouble_signs_project on public.trouble_signs (project_id, at desc);

create table if not exists public.trouble_scan (
  one     boolean primary key default true check (one),
  through timestamptz not null
);

alter table public.trouble_signs enable row level security;
alter table public.trouble_scan enable row level security;
revoke all on public.trouble_signs from anon, authenticated;
revoke all on public.trouble_scan from anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['trouble_signs', 'trouble_scan'] loop
    execute format('drop policy if exists %1$s_oauth_no_insert on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_insert on public.%1$s as restrictive for insert to authenticated with check (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_update on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_update on public.%1$s as restrictive for update to authenticated using (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_delete on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_delete on public.%1$s as restrictive for delete to authenticated using (not public.abo_is_oauth_client())', t);
  end loop;
end $$;

/** Finds the signs since the last scan and keeps them. Returns how many it kept or updated. Internal. */
create or replace function public.abo_trouble_scan()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  -- Two hours back from the last scan: a trace or run written late is still found.
  v_from timestamptz := coalesce((select through from public.trouble_scan), now() - interval '30 days') - interval '2 hours';
  -- A day's counts (a rule failing N times) count the whole day.
  v_day  timestamptz := date_trunc('day', v_from);
  v_n    integer;
begin
  insert into public.trouble_signs as s (key, kind, at, project_id, conversation_id, turn_id, detail, sample, weight)
  select key, kind, at, project_id, conversation_id, turn_id, detail, left(sample, 300), weight from (
    -- Luke's turns that went wrong (0175).
    select 'turn:' || coalesce(t.turn_id, t.id) as key, 'turn' as kind, t.created_at as at, t.project_id,
           t.conversation_id, t.turn_id,
           case
             when t.critic->>'verdict' = 'redo' then 'The critic sent the design back'
             when t.repairs >= 2 then 'Needed ' || t.repairs || ' repairs'
             else 'The turn failed'
           end as detail,
           coalesce(t.plan_goal, t.repair_errors->>0) as sample, 3 as weight
      from public.turn_traces t
     where t.created_at > v_from
       and (t.repairs >= 2 or t.critic->>'verdict' = 'redo'
            or exists (select 1 from public.messages m where m.id = t.turn_id and m.payload->>'type' = 'unanswered'))
    union all
    -- A turn the owner waited on: over ninety seconds.
    select 'slow:' || coalesce(t.turn_id, t.id), 'slow', t.created_at, t.project_id, t.conversation_id, t.turn_id,
           'A ' || coalesce(t.road, '') || ' turn took ' || round(t.took_ms / 1000.0) || ' s',
           t.plan_goal, 1
      from public.turn_traces t
     where t.created_at > v_from and t.took_ms > 90000
    union all
    -- A turn stopped before it answered.
    select 'stopped:' || m.id, 'slow', m.created_at, c.project_id, m.conversation_id, m.id,
           'The turn was stopped before it answered', null, 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.created_at > v_from and m.role = 'assistant' and m.payload->>'type' = 'stopped'
    union all
    -- Asked for what the app does not do (the gap check's unmet).
    select 'gap:' || coalesce(t.turn_id, t.id), 'gap', t.created_at, t.project_id, t.conversation_id, t.turn_id,
           'Asked for what the app can''t do', t.unmet->>0, 2
      from public.turn_traces t
     where t.created_at > v_from and jsonb_typeof(t.unmet) = 'array' and jsonb_array_length(t.unmet) > 0
    union all
    -- Luke saying he can't: a missing tool, or a wall.
    select 'cant:' || m.id, 'cant', m.created_at, c.project_id, m.conversation_id, m.id,
           'Luke says he can''t',
           coalesce(substring(m.payload->>'message' from '(?i)([^.!?\n]*(\mi can.?t\M|\mi cannot\M|i.?m (not able|unable) to|i don.?t have (a way|access|the ability)|i have no way|only you can|you(.?ll| will) (need|have) to (check|open|look|do|type|change)|isn.?t something (i|this platform|the app) can|not something (i|this platform) can|this platform (can.?t|cannot|has no way))[^.!?\n]*)'),
                    m.payload->>'message'), 2
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.created_at > v_from and m.role = 'assistant'
       and m.payload->>'type' in ('answer', 'clarify', 'plans', 'blueprint')
       and (m.payload->>'message') ~* '(\mi can.?t\M|\mi cannot\M|i.?m (not able|unable) to|i don.?t have (a way|access|the ability)|i have no way|only you can|you(.?ll| will) (need|have) to (check|open|look|do|type|change)|isn.?t something (i|this platform|the app) can|not something (i|this platform) can|this platform (can.?t|cannot|has no way))'
    union all
    -- The owner, unhappy, in their own words.
    select 'frustrated:' || m.id, 'frustrated', m.created_at, c.project_id, m.conversation_id, m.id,
           'The owner sounds unhappy', m.payload->>'text', 3
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.created_at > v_from and m.role = 'user'
       and (m.payload->>'text') ~* '(\mwrong\M|not what i|\mdumb\M|\mstupid\M|still (not|broken|wrong)|doesn.?t work|didn.?t work|not working|\mmessed up\M|why (is|did|does) it|why would|why (isn.?t|can.?t|not)\M|\m(liar|lie|lying)\M|can.?t you|are you (sure|serious)|\mseriously\M|\mgalat\M|phir se|nahi chahiye|kaam nahi|nahi ho raha|nahi hua|samajh nahi|\mbekar\M|kya kar raha|kyu nahi|^\s*\?+\s*$|\?\?)'
    union all
    -- Built again and again: three builds in one conversation within an hour.
    select distinct on (b.conversation_id, b.day)
           'rebuilds:' || b.conversation_id || ':' || b.day, 'rebuilds', b.created_at, c.project_id, b.conversation_id, b.id,
           b.n || ' builds in one conversation, three within ' || ceil(extract(epoch from b.third - b.created_at) / 60) || ' min',
           b.words, 2
      from (
        select m.id, m.conversation_id, m.created_at, (m.created_at at time zone 'UTC')::date as day,
               lead(m.created_at, 2) over (partition by m.conversation_id order by m.created_at) as third,
               count(*) over (partition by m.conversation_id, (m.created_at at time zone 'UTC')::date) as n,
               m.payload->>'message' as words
          from public.messages m
         where m.created_at > v_day and m.role = 'assistant' and m.payload->>'type' = 'build'
      ) b
      join public.conversations c on c.id = b.conversation_id
     where b.third is not null and b.third - b.created_at <= interval '60 minutes'
    union all
    -- A section changed again and again in a day (0175).
    select 'churn:' || mo.id || ':' || (s.created_at at time zone 'UTC')::date, 'churn', max(s.created_at), mo.project_id,
           null, null,
           mo.nav_label || ' changed ' || count(*) || ' times in a day',
           string_agg(left(coalesce(s.change_description, ''), 60), ' · ' order by s.version), 1
      from public.ui_schemas s
      join public.modules mo on mo.id = s.module_id
     where s.created_at > v_day
     group by mo.id, mo.project_id, mo.nav_label, (s.created_at at time zone 'UTC')::date
    having count(*) >= 4
    union all
    -- A rule failing on its runs, a day at a time (0175; a refused write fails a run, 0206).
    select 'rule:' || a.id || ':' || f.day, 'rule', f.at, a.project_id, null, null,
           'Rule "' || a.name || '" failed ' || f.n || ' time' || case when f.n = 1 then '' else 's' end,
           f.error, 3
      from public.automations a
      join lateral (
        select e.day, count(*) as n, max(e.at) as at, max(e.error) as error from (
          select r.created_at as at, (r.created_at at time zone 'UTC')::date as day, r.detail->>'error' as error
            from public.automation_runs r
           where r.automation_id = a.id and not r.ok and r.created_at > v_day
          union all
          select coalesce(j.finished_at, j.created_at), (coalesce(j.finished_at, j.created_at) at time zone 'UTC')::date, j.error
            from public.code_jobs j
           where j.automation_id = a.id and j.status = 'failed' and j.created_at > v_day
        ) e group by e.day
      ) f on true
    union all
    -- A rule that ran and changed nothing, again and again in a day (runs that say what they wrote, 0206).
    select 'idle:' || a.id || ':' || i.day, 'idle', i.at, a.project_id, null, null,
           'Rule "' || a.name || '" ran ' || i.n || ' times and changed nothing', a.definition->'trigger'->>'type', 2
      from public.automations a
      join lateral (
        select (r.created_at at time zone 'UTC')::date as day, count(*) as n, max(r.created_at) as at
          from public.automation_runs r
         where r.automation_id = a.id and r.created_at > v_day and r.ok and r.detail ? 'wrote'
         group by 1
        having count(*) >= 3 and max((r.detail->>'wrote')::numeric) = 0
      ) i on true
    union all
    -- A rule set off by rows, unconditionally, that never ran though rows came: the platform did not fire it.
    select 'idle:never:' || a.id, 'idle', a.created_at, a.project_id, null, null,
           'Rule "' || a.name || '" never ran, though rows were ' ||
             case when a.definition->'trigger'->>'type' = 'record_created' then 'added' else 'changed' end,
           a.definition->'trigger'->>'type', 2
      from public.automations a
     where a.enabled and a.created_at > now() - interval '7 days' and a.created_at < now() - interval '1 hour'
       and a.definition->'trigger'->>'type' in ('record_created', 'record_updated')
       and a.definition->'trigger'->'when' is null
       and exists (
         select 1 from public.records rec
          where rec.module_id = a.module_id
            and case when a.definition->'trigger'->>'type' = 'record_created' then rec.created_at else rec.updated_at end
                between a.created_at and now() - interval '10 minutes')
       and not exists (select 1 from public.automation_runs r where r.automation_id = a.id)
       and not exists (select 1 from public.code_jobs j where j.automation_id = a.id)
    union all
    -- A rule handed a list cut short (0206): it saw less than there was.
    select 'cut:' || a.id || ':' || (r.created_at at time zone 'UTC')::date, 'cut', max(r.created_at), a.project_id, null, null,
           'Rule "' || a.name || '" read a list cut short ' || count(*) || ' time' || case when count(*) = 1 then '' else 's' end,
           null, 2
      from public.automation_runs r
      join public.automations a on a.id = r.automation_id
     where r.created_at > v_day
       and exists (select 1 from jsonb_each(case when jsonb_typeof(r.detail->'read') = 'object' then r.detail->'read' else '{}'::jsonb end) e
                    where jsonb_typeof(e.value) = 'object' and (e.value->>'cut')::boolean)
     group by a.id, a.project_id, a.name, (r.created_at at time zone 'UTC')::date
    union all
    -- A written screen that broke while it ran (0178).
    select 'screen:' || e.project_id || ':' || coalesce(e.module_id::text, '') || ':' || e.screen || ':' || (e.at at time zone 'UTC')::date,
           'screen', max(e.at), e.project_id, null, null,
           'The screen "' || e.screen || '" on ' || coalesce(mo.nav_label, 'a section') || ' broke ' || count(*) || ' time' || case when count(*) = 1 then '' else 's' end,
           (array_agg(e.message order by e.at desc))[1], 2
      from public.screen_errors e
      left join public.modules mo on mo.id = e.module_id
     where e.at > v_day
     group by e.project_id, e.module_id, mo.nav_label, e.screen, (e.at at time zone 'UTC')::date
    union all
    -- A schedule setting fields on every row: a default filled in by hand (0175).
    select 'workaround:schedule:' || a.id, 'workaround', a.created_at, a.project_id, null, null,
           'Rule "' || a.name || '" sets fields on every row, every run',
           (a.definition->'actions')::text, 1
      from public.automations a
     where a.created_at > v_from and a.enabled
       and a.definition->'trigger'->>'type' = 'schedule'
       and a.definition->'trigger'->'when' is null
       and a.definition->'actions' @> '[{"type": "set_fields"}]'::jsonb
    union all
    -- Three or more yes/no or status fields sharing a word: one fact kept three ways (0175).
    select 'workaround:fields:' || w.module_id || ':' || w.word, 'workaround', w.at, w.project_id, null, null,
           w.nav_label || ' has ' || w.n || ' fields for "' || w.word || '"', w.fields, 1
      from (
        select mo.id as module_id, mo.project_id, mo.nav_label, s.created_at as at, tok.word,
               count(*) as n, string_agg(col->>'field', ', ') as fields
          from public.modules mo
          join lateral (select * from public.ui_schemas u where u.module_id = mo.id order by u.version desc limit 1) s on true
          cross join lateral jsonb_array_elements(s.schema_json->'columns') col
          cross join lateral regexp_split_to_table(col->>'field', '_') tok(word)
         where s.created_at > v_from
           and col->>'type' in ('boolean', 'badge', 'dropdown')
           and length(tok.word) >= 3
           and tok.word not in ('status', 'state', 'type', 'flag', 'stage', 'kind')
         group by mo.id, mo.project_id, mo.nav_label, s.created_at, tok.word
        having count(*) >= 3
      ) w
    union all
    -- The owner left Luke's plan or question unanswered: the last word, twelve hours on.
    select 'left:' || m.id, 'left', m.created_at, c.project_id, m.conversation_id, m.id,
           'The owner left ' || case when m.payload->>'type' = 'clarify' then 'a question' else 'a plan' end || ' unanswered',
           m.payload->>'message', 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.created_at between now() - interval '7 days' and now() - interval '12 hours'
       and m.role = 'assistant' and m.payload->>'type' in ('blueprint', 'plans', 'clarify')
       and not exists (select 1 from public.messages n where n.conversation_id = m.conversation_id and n.created_at > m.created_at)
  ) found
  on conflict (key) do update
     set at = excluded.at, detail = excluded.detail, sample = excluded.sample, weight = excluded.weight;
  get diagnostics v_n = row_count;

  delete from public.trouble_signs where at < now() - interval '120 days';
  insert into public.trouble_scan (one, through) values (true, now())
  on conflict (one) do update set through = now();
  return v_n;
end $$;
revoke all on function public.abo_trouble_scan() from public, anon, authenticated;

-- 0184's, reading what was kept: fresh first, then newest first, with the turn and the weight.
drop function if exists public.abo_admin_trouble(integer, uuid, uuid);
create or replace function public.abo_admin_trouble(p_days integer default 7, p_account uuid default null, p_app uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_scope uuid[] := public.abo_admin_scope(p_account, p_app);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  perform public.abo_trouble_scan();
  return coalesce((
    select jsonb_agg(x order by x.at desc)
      from (
        select s.kind, s.at, s.detail, s.sample, s.conversation_id, s.turn_id, s.weight,
               p.id as project_id, p.name as project,
               (select c.title from public.conversations c where c.id = s.conversation_id) as title
          from public.trouble_signs s
          join public.projects p on p.id = s.project_id
         where s.at > v_since and (v_scope is null or s.project_id = any(v_scope))
         order by s.at desc
         limit 200
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function public.abo_admin_trouble(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_trouble(integer, uuid, uuid) to authenticated;

/**
 * Yesterday, in the console's zone: how many signs, the day before for the
 * trend, by kind, and the conversations (or apps) that went worst by weight.
 */
create or replace function public.abo_admin_trouble_day(p_account uuid default null, p_app uuid default null, p_zone text default 'Asia/Kolkata') returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_scope uuid[] := public.abo_admin_scope(p_account, p_app);
  v_zone  text := coalesce(nullif(btrim(p_zone), ''), 'Asia/Kolkata');
  v_day   date;
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  begin
    v_day := (now() at time zone v_zone)::date - 1;
  exception when others then
    v_zone := 'Asia/Kolkata';
    v_day := (now() at time zone v_zone)::date - 1;
  end;
  perform public.abo_trouble_scan();
  return (
    with day as (
      select s.*, (s.at at time zone v_zone)::date as on_day
        from public.trouble_signs s
       where s.at >= (v_day - 1)::timestamp at time zone v_zone
         and s.at < (v_day + 1)::timestamp at time zone v_zone
         and (v_scope is null or s.project_id = any(v_scope))
    ),
    y as (select * from day where on_day = v_day)
    select jsonb_build_object(
      'day', v_day,
      'total', (select count(*) from y),
      'before', (select count(*) from day where on_day = v_day - 1),
      'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'n', n) order by n desc, kind)
                           from (select kind, count(*) as n from y group by kind) k), '[]'::jsonb),
      'worst', coalesce((
        select jsonb_agg(w order by w.score desc, w.at desc)
          from (
            select sum(y.weight) as score, count(*) as n, max(y.at) as at,
                   y.project_id, p.name as project, y.conversation_id,
                   (select c.title from public.conversations c where c.id = y.conversation_id) as title,
                   (select jsonb_agg(distinct y2.kind) from y y2
                     where y2.project_id = y.project_id and y2.conversation_id is not distinct from y.conversation_id) as kinds,
                   (array_agg(y.sample order by y.weight desc, y.at desc) filter (where y.sample is not null))[1] as sample
              from y join public.projects p on p.id = y.project_id
             group by y.project_id, p.name, y.conversation_id
             order by sum(y.weight) desc, max(y.at) desc
             limit 5
          ) w
      ), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.abo_admin_trouble_day(uuid, uuid, text) from public, anon;
grant execute on function public.abo_admin_trouble_day(uuid, uuid, text) to authenticated;

-- Every fifteen minutes where pg_cron is installed (production); the check
-- project has none, and Needs a look scans when it is opened.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-trouble-scan', '*/15 * * * *', 'select public.abo_trouble_scan()');
  end if;
end $$;

notify pgrst, 'reload schema';
