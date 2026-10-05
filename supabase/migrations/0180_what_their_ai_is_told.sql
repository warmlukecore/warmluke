-- Migration 0180: what their AI is told, and how its asks come out
--
-- The merchant's own AI now connects to a guide (lib/client-guide.ts):
-- how to help them as Luke does, from the lists Luke reads, their app
-- and what Luke learned there. Its version is a hash of everything but
-- the merchant's part, so a change to a shared rule or a tool's words is
-- a new version by itself. Each call now says which guide was current
-- and how it came out, and the console's "Their AI" screen reads it back:
--
--   guide      the guide's version when the call was made
--   outcome    what the answer said it was (not accepted, holds, built,
--              waiting for approval, luke changed it, nothing to change,
--              error, answered…), read off the answer itself and never
--              listed per tool (outcomeOf in lib/client-guide.ts)
--   problems   for an answer that listed what was wrong, how many
--
-- abo_mcp_call stays as it was for the code still running when this
-- lands; abo_mcp_record is the same limit and row, with the guide, and
-- the row's id back so its outcome can follow (abo_mcp_outcome: the
-- caller's own row, once). Kept as long as the calls already are.

alter table public.mcp_calls add column if not exists guide text;
alter table public.mcp_calls add column if not exists outcome text;
alter table public.mcp_calls add column if not exists problems integer;

create or replace function public.abo_mcp_record(p_tool text, p_guide text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_recent integer;
  v_limit  integer := 300;
  v_id     bigint;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select count(*) into v_recent
    from public.mcp_calls
   where user_id = auth.uid()
     and created_at > now() - interval '1 hour';

  if v_recent >= v_limit then
    return jsonb_build_object('ok', false, 'used', v_recent, 'limit', v_limit);
  end if;

  insert into public.mcp_calls (user_id, client_id, tool, guide)
  values (auth.uid(), nullif(auth.jwt() ->> 'client_id', ''), left(coalesce(p_tool, '?'), 60), left(p_guide, 20))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'used', v_recent + 1, 'limit', v_limit, 'id', v_id);
end $$;

revoke all on function public.abo_mcp_record(text, text) from public, anon;
grant execute on function public.abo_mcp_record(text, text) to authenticated;

create or replace function public.abo_mcp_outcome(p_id bigint, p_outcome text, p_problems integer)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.mcp_calls
     set outcome  = left(coalesce(p_outcome, '?'), 40),
         problems = case when p_problems is null then null else least(greatest(p_problems, 0), 1000) end
   where id = p_id
     and user_id = auth.uid()
     and outcome is null;
end $$;

revoke all on function public.abo_mcp_outcome(bigint, text, integer) from public, anon;
grant execute on function public.abo_mcp_outcome(bigint, text, integer) to authenticated;

-- ── Their AI, for the console ───────────────────────────────────
-- Calls from an outside assistant (a client id on the token) over the
-- last p_days, the same figures by guide, by week, by tool and in all;
-- each tool's outcomes; and the requests their AI raised, by where they
-- ended up. Outcomes and statuses are counted as the rows hold them, so a
-- new one shows up by itself.
create or replace function public.abo_admin_their_ai(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
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
                            where client_id is not null and created_at >= v_since group by 1) r)
    )
  );
end $$;

revoke all on function public.abo_admin_their_ai(integer) from public, anon;
grant execute on function public.abo_admin_their_ai(integer) to authenticated;

NOTIFY pgrst, 'reload schema';
