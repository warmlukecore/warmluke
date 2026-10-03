-- Migration 0169: how often Luke takes the wrong road
--
-- Which road a turn takes is decided by rules in code (lib/intent.ts):
-- free and instant, and right for nearly every message. A wrong turn is
-- never a wrong answer, only a dearer one: a question sent down the
-- design road pays for the planner and the whole contract (2 Oct: $0.25
-- for "hows my store doing"), and a build sent down the talk road is
-- handed back, paying for one talk call. This says how often each
-- happens, so the day the rules stop being enough (another script,
-- phrasing they do not know) is a number on the Spend screen, not a
-- merchant's bill: past one turn in ten, it is time for a small model
-- to read the messages the rules are unsure of.

create or replace function public.abo_admin_routing(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
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
    )
    select jsonb_build_object(
             'turns', count(*),
             'answered_on_design', count(*) filter (where road = 'design' and ended = 'answer' and not handed_back),
             'handed_back', count(*) filter (where handed_back),
             'wrong_road_usd', round(coalesce(sum(usd) filter (where road = 'design' and ended = 'answer' and not handed_back), 0), 4))
      from t
  );
end $$;
revoke all on function public.abo_admin_routing(integer) from public, anon;
grant execute on function public.abo_admin_routing(integer) to authenticated;

NOTIFY pgrst, 'reload schema';
