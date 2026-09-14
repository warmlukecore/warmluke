-- Migration 0029: an assistant can ask for something to be built.
--
-- A merchant talking to their own Claude says "orders keep getting
-- packed wrong, sort that out". Claude cannot build it — 0028 made
-- sure of that, and should have. What it can do is carry the request
-- across, and this is where the request lands.
--
-- Claude sends words, not a design. Handing it the engine's own plan
-- format would put every gate this app has — the one refusing a scan
-- that writes a count it never took, the one refusing a rule that
-- derives a date from the clock — on the wrong side of the fence. The
-- design is still made here, by the engine, and still approved by the
-- merchant on the same card as always.
--
-- So this table holds a sentence and who asked. Nothing is built by
-- writing to it.

create table if not exists public.build_requests (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  -- Which AI client asked, taken from the token's own claim rather
  -- than anything it told us. A merchant reading "Claude asked for
  -- this" should be reading the token, not a name a caller typed.
  client_id    text,
  request      text not null,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  constraint build_requests_status_allowed
    check (status in ('pending', 'opened', 'dismissed'))
);
create index if not exists idx_build_requests_project
  on public.build_requests(project_id, status, created_at desc);

alter table public.build_requests enable row level security;

-- The owner reads them and marks them done. Creating one goes through
-- the function below, so a request always carries a real client_id
-- rather than whatever a caller claimed.
drop policy if exists "build_requests_owner_read" on public.build_requests;
create policy "build_requests_owner_read" on public.build_requests
  for select using (public.abo_owns(project_id));

drop policy if exists "build_requests_owner_update" on public.build_requests;
create policy "build_requests_owner_update" on public.build_requests
  for update using (public.abo_owns(project_id))
  with check (public.abo_owns(project_id));

-- Records what an assistant was asked for.
--
-- Security definer because 0028 refuses every write from a token
-- carrying client_id, and this is the one thing such a token should be
-- able to do. Narrow on purpose: one row, one sentence, no effect on
-- anything until a person opens it.
create or replace function public.abo_mcp_propose(
  p_project uuid,
  p_request text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  -- The caller's own ownership, checked here because the definer
  -- context has switched off the policy that would have done it.
  if not exists (
    select 1 from public.projects where id = p_project and owner_id = auth.uid()
  ) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_request), '') = '' then
    raise exception 'A request needs some words.' using errcode = '22023';
  end if;

  insert into public.build_requests (project_id, requested_by, client_id, request)
  values (
    p_project,
    auth.uid(),
    nullif(auth.jwt() ->> 'client_id', ''),
    left(btrim(p_request), 2000)
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.abo_mcp_propose(uuid, text) from public;
grant execute on function public.abo_mcp_propose(uuid, text) to authenticated;

NOTIFY pgrst, 'reload schema';
