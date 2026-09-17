-- Migration 0076: the ceiling moved out of the route, and stayed here.
--
-- 0072 took the five-a-day cap out of the route that stores designs and
-- put it in the one place a yes is written, so it could not be talked
-- round by asking again through another tool. That was right.
--
-- Then the setting changed meaning. "Build without asking me first" now
-- says it applies to everything, and the screen says "still waits for
-- you: nothing". The route's own ceiling went with it. This one did
-- not, so the sixth design of the day is still refused a stamp — and
-- the route never read the answer, so it went on to apply plans that
-- abo_build then rejected one by one for want of an approved_at. The
-- merchant sees a design waiting under a switch that promises nothing
-- waits.
--
-- The cap is removed rather than raised. What it guarded against was a
-- client in a loop, and a design already spends one of the merchant's
-- included turns before it reaches this function — the quota stops the
-- loop, and the cap only ever stopped the merchant who meant it.
--
-- Everything else here is unchanged and still matters: a client may
-- only stamp its own request, and only while auto_build is on. With
-- the switch off, a client asking to approve its own design is still
-- refused and the design still waits in Warmluke.
--
-- Callers: src/app/api/mcp/route.ts (propose_change auto-build,
-- submit_design auto-build, approve_change).

create or replace function public.abo_approve_request(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_client  text := nullif(auth.jwt() ->> 'client_id', '');
  v_auto    boolean;
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
  end if;

  update public.build_requests
     set approved_at = coalesce(approved_at, now()),
         approved_by = coalesce(approved_by, auth.uid())
   where id = p_request;

  return jsonb_build_object('approved', true);
end $$;

NOTIFY pgrst, 'reload schema';
