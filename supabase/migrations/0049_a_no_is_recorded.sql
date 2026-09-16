-- Migration 0049: a merchant saying no, written down.
--
-- The tool surface could propose, list, approve and look back, but it
-- had no way to record a refusal. So when the merchant read a design
-- inside their own assistant and said "no, leave it", that decision
-- went nowhere: pending_changes went on reporting it as waiting, the
-- bell went on counting it, and the only way to make the no real was
-- to open Warmluke and dismiss it there.
--
-- Which is the same failure as every other one this week — something
-- true in the room and nowhere in the database.
--
-- The twin of abo_approve_request, and deliberately shaped like it. A
-- client may refuse a request it raised; it may not touch one raised
-- in the app or by another assistant. Unlike approving, this needs no
-- auto-build switch: throwing a design away is not a change to the
-- merchant's app, and a client discarding its own proposal is doing
-- exactly what it should.
--
-- Callers: src/app/api/mcp/route.ts.

create or replace function public.abo_reject_request(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_client text := nullif(auth.jwt() ->> 'client_id', '');
  v_status text;
  v_n      integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select r.status into v_status
    from public.build_requests r
   where r.id = p_request
     and public.abo_owns(r.project_id)
     -- A client refusing somebody else's request would be the approval
     -- hole through a different door.
     and (v_client is null or r.client_id is not distinct from v_client);

  if v_status is null then
    return jsonb_build_object('rejected', false, 'reason', 'no such request on this account');
  end if;

  -- Asking twice is not an error. The answer is the state it is in.
  if v_status = 'dismissed' then
    return jsonb_build_object('rejected', true, 'already', true, 'status', 'dismissed');
  end if;

  if v_status not in ('pending', 'building') then
    return jsonb_build_object(
      'rejected', false,
      'status', v_status,
      'reason', 'that is already finished — there is nothing left to refuse'
    );
  end if;

  update public.build_requests
     set status      = 'dismissed',
         resolved_at = now()
   where id = p_request
     and status in ('pending', 'building');
  get diagnostics v_n = row_count;

  -- Zero rows means somebody moved it between the read and the write.
  return jsonb_build_object(
    'rejected', v_n > 0,
    'status', case when v_n > 0 then 'dismissed' else v_status end
  );
end $$;

revoke all on function public.abo_reject_request(uuid) from public;
grant execute on function public.abo_reject_request(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
