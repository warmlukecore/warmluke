-- Migration 0175: what needs a look
--
-- Tanish found the RTO tangle, the ugly screen and the deleted section's
-- broken rule by hand, and told us on Slack. The signs were all in the
-- database the day they happened: a thread where the owner said "that
-- was so dumb", one section changed seven times in a day, a rule writing
-- "No" into 2,353 rows, near-duplicate fields (rto, rto_status, is_rto,
-- rto_flag). This lists them for whoever runs the console, newest first,
-- each with where to look, so a problem is seen the day it happens and
-- fixed at its root before a merchant has to report it.
--
-- Signs, over the last p_days (1 to 90):
--   turn       Luke failed, needed two or more repairs, or the critic sent
--              a design back
--   frustrated an owner's words that say it went wrong
--   churn      one section changed four or more times in a day
--   rule       a rule that failed on its runs
--   workaround a schedule that sets fields on every row with no condition;
--              three or more yes/no or status fields sharing a word
--
-- ponytail: words matched by a list, not understood; a judge model over
-- the threads is the upgrade if the list misses or shouts.

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
