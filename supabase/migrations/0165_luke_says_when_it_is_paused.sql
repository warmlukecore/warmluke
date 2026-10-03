-- Migration 0165: the console says when Luke is paused
--
-- On 3 October the model account ran out. Merchants' turns failed for an
-- hour, each told "ask again, in other words", and the first anyone here
-- knew was a merchant asking why. A turn that fails because the model was
-- not there now keeps what it was (payload.failed: billing, auth, busy,
-- down…, from lib/ai's ModelError); this is the console's question of it:
-- is Luke failing now, since when, and for how many.
--
-- "Now" is the newest answer Luke settled: a failure there, and the
-- console says so until an answer comes through again.

create index if not exists messages_created_at on public.messages (created_at);

create or replace function public.abo_admin_luke_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ok timestamptz;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;
  -- The newest answer that came, in the last week.
  select max(m.created_at) into v_ok
    from public.messages m
   where m.role = 'assistant' and m.created_at > now() - interval '7 days'
     and coalesce(m.payload->>'type', '') not in ('answering', 'unanswered', 'stopped', '');
  return (
    select jsonb_build_object(
             'failing', count(*) > 0,
             'kind', (array_agg(m.payload->>'failed' order by m.created_at desc))[1],
             'since', min(m.created_at),
             'turns', count(*),
             'projects', count(distinct c.project_id),
             'last_answer', v_ok)
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.role = 'assistant' and m.created_at > greatest(coalesce(v_ok, '-infinity'), now() - interval '24 hours')
       and m.payload->>'type' = 'unanswered' and m.payload ? 'failed'
  );
end $$;
revoke all on function public.abo_admin_luke_health() from public, anon;
grant execute on function public.abo_admin_luke_health() to authenticated;

NOTIFY pgrst, 'reload schema';
