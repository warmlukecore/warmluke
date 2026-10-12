-- Migration 0210: no limit drops work silently
--
-- The code queue's tick sent at most twenty projects a minute
-- (abo_code_waiting, 0136): with more than twenty projects holding queued
-- jobs, the rest waited for a later minute that the same twenty could
-- take again. Two hundred a tick, as the import and connector ticks send;
-- each project's worker then drains its queue in batches until its time
-- is spent (lib/code-rules runQueuedJobs), not twenty jobs and stop.
--
-- The oldest waiting first, so no project waits behind newer ones.
--
-- docs/reference/limits.md lists every limit and what says it.

create or replace function public.abo_code_waiting()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select q.project_id
    from public.code_jobs q
   where q.status = 'queued'
     and not exists (select 1 from public.code_leases l where l.project_id = q.project_id and l.expires_at > now())
   group by q.project_id
   order by min(q.created_at)
   limit 200
$$;
revoke all on function public.abo_code_waiting() from public, anon, authenticated;

notify pgrst, 'reload schema';
