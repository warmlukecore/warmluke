-- Migration 0072: a daily ceiling with a door beside it.
--
-- Auto-build is capped at five a day per project, counted in the route
-- before a design is applied. Past five, the sixth is stored pending
-- instead of built — which is right.
--
-- And then the same assistant calls approve_change, and it is built.
-- abo_approve_request stamps any of the client's own requests whenever
-- auto_build is on; it never knew about the ceiling, because the
-- ceiling lived in the route that stores designs and not in the
-- function that approves them. So the limit held for the path that
-- respected it and stood aside for the path that did not.
--
-- The count moves here. This is the only place a yes gets written, so
-- it is the only place the question can be asked once: the route may
-- still decide not to auto-build, but it can no longer be talked round
-- by asking again through another tool.
--
-- Only clients are counted. A merchant approving their own design in
-- Warmluke is not automation and has never been capped — the cap
-- exists so an assistant in a loop cannot rebuild an app all night.
--
-- ponytail: the number lives in two places now, here and
-- AUTO_BUILDS_PER_DAY in the route. The route's copy decides whether
-- to try; this one decides whether it is allowed. Move both to a
-- settings row when the limit becomes something a plan sets.
--
-- Callers: src/app/api/mcp/route.ts (approve_change).

create or replace function public.abo_approve_request(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_client  text := nullif(auth.jwt() ->> 'client_id', '');
  v_auto    boolean;
  v_today   integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select r.project_id into v_project
    from public.build_requests r
   where r.id = p_request
     and public.abo_owns(r.project_id)
     and r.status in ('pending', 'building')
     -- A client stamping a request that is not even its own would be
     -- the same hole through a different door.
     and (v_client is null or r.client_id is not distinct from v_client);

  if v_project is null then
    return jsonb_build_object('approved', false, 'reason', 'no such request waiting here');
  end if;

  if v_client is not null then
    select p.auto_build into v_auto from public.projects p where p.id = v_project;
    if not coalesce(v_auto, false) then
      return jsonb_build_object(
        'approved', false,
        'reason', 'the merchant approves this one in Warmluke'
      );
    end if;

    -- The ceiling, asked here rather than only where designs are
    -- stored. Rolling twenty-four hours, matching the route.
    select count(*) into v_today
      from public.build_requests r
     where r.project_id = v_project
       and r.auto_built
       and r.built_at > now() - interval '24 hours';

    if v_today >= 5 then
      return jsonb_build_object(
        'approved', false,
        'reason', 'this app has already been built automatically five times today; the merchant approves the rest in Warmluke'
      );
    end if;
  end if;

  update public.build_requests
     set approved_at = coalesce(approved_at, now()),
         approved_by = coalesce(approved_by, auth.uid())
   where id = p_request;

  return jsonb_build_object('approved', true);
end $$;

NOTIFY pgrst, 'reload schema';
