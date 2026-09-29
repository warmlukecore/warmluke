-- The code queue's clock sends work again.
--
-- abo_code_tick chose the projects to send with
--   select distinct j.project_id from public.code_jobs j ...
-- inside a function with a record variable also named j. PL/pgSQL read
-- j.project_id as that variable's field, so from the moment
-- code_worker_url was set every tick failed, "record "j" has no field
-- "project_id"", and no queued code ever reached the worker. The check
-- project never has code_worker_url, so in every test the tick returned
-- before that query ran.
--
-- The choice moves to a SQL function of its own, where no variable can
-- stand for a column, and check-code-jobs-live asks it directly.

/** Projects with code queued and no worker on them: the ones the tick sends. */
create or replace function public.abo_code_waiting()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct q.project_id from public.code_jobs q
   where q.status = 'queued'
     and not exists (select 1 from public.code_leases l where l.project_id = q.project_id and l.expires_at > now())
   limit 20
$$;

create or replace function public.abo_code_tick()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_sent integer := 0;
  j record;
  v_merged boolean;
begin
  -- A job whose worker died (a function lives five minutes; this is three
  -- times that). One at a time: its rows join the rule's open job when
  -- there is one, since two open jobs for a rule cannot be; else it goes
  -- back on the queue, three tries in all.
  for j in
    select id, automation_id, kind, row_ids, attempts from public.code_jobs
     where status = 'running' and coalesce(started_at, created_at) < now() - interval '15 minutes'
     order by coalesce(started_at, created_at)
  loop
    update public.code_jobs q set row_ids = (q.row_ids || j.row_ids)[1:500]
     where q.automation_id = j.automation_id and q.kind = j.kind and q.status = 'queued';
    v_merged := found;
    if v_merged or j.attempts >= 3 then
      update public.code_jobs
         set status = 'failed', finished_at = now(),
             error = case when v_merged then 'The worker stopped before it finished; the next run takes its rows.'
                          else 'The worker stopped before it finished, three times.' end
       where id = j.id;
    else
      update public.code_jobs set status = 'queued' where id = j.id;
    end if;
  end loop;
  if not exists (select 1 from vault.decrypted_secrets where name = 'code_worker_url') then
    return 0;
  end if;
  for v_project in select * from public.abo_code_waiting()
  loop
    if public.abo_code_dispatch(v_project) = 'sent' then v_sent := v_sent + 1; end if;
  end loop;
  return v_sent;
end $$;

revoke all on function public.abo_code_waiting() from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
