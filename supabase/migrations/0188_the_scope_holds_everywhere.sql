-- The scope holds in the two places 0184 missed (6 Oct): Learning's
-- "Across stores" read every store's lessons when the console was
-- narrowed to one account, and the access log's counts beside each kind
-- of act counted every account and every administrator while its rows
-- were narrowed. Both now count what the scope names.

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
                   and (v_scope is null or project_id = any(v_scope))
                 group by lower(title)
                 order by sum(uses) desc, count(distinct project_id) desc
                 limit 20) x)));
end $$;
revoke all on function public.abo_admin_learning(integer, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_learning(integer, uuid, uuid) to authenticated;

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
               where created_at >= v_since
                 and (p_admin is null or actor_user_id = p_admin)
                 and (v_people is null or target_user_id = any(v_people))
               group by action) x), '{}'::jsonb),
    -- Who has acted, for the Admin filter.
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.actor_user_id, 'email', u.email) order by u.email)
        from (select distinct actor_user_id from public.admin_account_audit where actor_user_id is not null) x
        left join auth.users u on u.id = x.actor_user_id), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_access_log(text, text, integer, integer, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.abo_admin_access_log(text, text, integer, integer, timestamptz, uuid, uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
