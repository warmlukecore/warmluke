-- Migration 0151: a teammate can leave
--
-- Only the owner could take a seat away (0017), so someone who had
-- moved on stayed on the team until the owner noticed. A member may
-- now delete their own seat: the same row the owner's Remove deletes,
-- so leaving and being removed end the same way. What they shared or
-- hid goes with the seat (on delete cascade, 0140/0145); what they
-- built stays with the owner. The OAuth wall (0028, 0070) still
-- refuses a delete from an AI client, so only the person, in the app,
-- can leave.

drop policy if exists "members_self_leave" on public.project_members;
create policy "members_self_leave" on public.project_members
  for delete to authenticated using (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
