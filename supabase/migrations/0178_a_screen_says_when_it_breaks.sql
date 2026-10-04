-- Migration 0178: a written screen says when it breaks
--
-- A screen Luke writes runs in a frame of its own. When it broke (a read
-- the app refused, its own error) it showed a red line of its own and
-- nobody heard of it: Tanish's flagged-orders screen said "Could not load
-- the flagged orders" and only Tanish knew (4 Oct). The kit now tells the
-- app, the app says so under the screen with "Ask Luke to fix it", and
-- each message is kept here once a visit, so the console's Needs a look
-- lists it beside the other signs.

create table if not exists public.screen_errors (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  module_id  uuid references public.modules(id) on delete cascade,
  screen     text not null check (char_length(screen) between 1 and 200),
  message    text not null check (char_length(message) between 1 and 300),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at         timestamptz not null default now()
);
create index if not exists screen_errors_newest on public.screen_errors (at desc);
create index if not exists screen_errors_project on public.screen_errors (project_id, at desc);

alter table public.screen_errors enable row level security;

-- Written by whoever had the screen open, for a project they may use;
-- read by nobody but the console's own function.
drop policy if exists screen_errors_tell on public.screen_errors;
create policy screen_errors_tell on public.screen_errors
  for insert to authenticated
  with check (user_id = auth.uid() and public.abo_can_use(project_id));

-- And the wall every table has: no write from a connected client's token.
drop policy if exists screen_errors_oauth_no_insert on public.screen_errors;
create policy screen_errors_oauth_no_insert on public.screen_errors
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists screen_errors_oauth_no_update on public.screen_errors;
create policy screen_errors_oauth_no_update on public.screen_errors
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists screen_errors_oauth_no_delete on public.screen_errors;
create policy screen_errors_oauth_no_delete on public.screen_errors
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- Needs a look, as 0175 has it, with the screens beside the other signs.
create or replace function public.abo_admin_trouble(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
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
revoke all on function public.abo_admin_trouble(integer) from public, anon;
grant execute on function public.abo_admin_trouble(integer) to authenticated;
NOTIFY pgrst, 'reload schema';
