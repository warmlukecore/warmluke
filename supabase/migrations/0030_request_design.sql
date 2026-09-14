-- Migration 0030: a request carries the design it was given.
--
-- 0029 stored the sentence and nothing else, so the merchant had to
-- open the app to find out what would be built. That is a screen
-- switch for the one thing they were being asked to judge. The design
-- is still made by the engine — Claude never writes plans — but it now
-- travels back with the request, so the plan Claude reads out and the
-- plan that gets built are the same object.

alter table public.build_requests
  add column if not exists plans      jsonb,
  add column if not exists summary    text,
  add column if not exists built_at   timestamptz;

-- 'built' joins the list: a request can now be approved and applied
-- without anyone opening the app.
alter table public.build_requests
  drop constraint if exists build_requests_status_allowed;
alter table public.build_requests
  add constraint build_requests_status_allowed
  check (status in ('pending', 'opened', 'building', 'dismissed', 'built'));

-- The 2-arg version goes: a request without its design is the state
-- this migration exists to remove, and leaving the old signature in
-- place would let a caller keep creating them.
drop function if exists public.abo_mcp_propose(uuid, text);

create or replace function public.abo_mcp_propose(
  p_project uuid,
  p_request text,
  p_plans   jsonb default null,
  p_summary text  default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects where id = p_project and owner_id = auth.uid()
  ) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_request), '') = '' then
    raise exception 'A request needs some words.' using errcode = '22023';
  end if;
  -- Plans are an array of plan objects or nothing. Checked here
  -- because this is the one door 0028 leaves open, and a door that
  -- accepts any shape is a door that accepts a surprise.
  if p_plans is not null and jsonb_typeof(p_plans) <> 'array' then
    raise exception 'Plans must be a list.' using errcode = '22023';
  end if;
  if p_plans is not null and jsonb_array_length(p_plans) > 6 then
    raise exception 'Too many plans in one request.' using errcode = '22023';
  end if;

  -- A burst of proposals is a stuck loop, not a merchant. Each one
  -- costs a model call on the way in, so the ceiling lives in the
  -- database where every caller passes through it.
  if (
    select count(*) from public.build_requests
     where requested_by = auth.uid() and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'Too many requests in the last hour.' using errcode = '53400';
  end if;

  insert into public.build_requests
    (project_id, requested_by, client_id, request, plans, summary)
  values (
    p_project,
    auth.uid(),
    nullif(auth.jwt() ->> 'client_id', ''),
    left(btrim(p_request), 2000),
    p_plans,
    left(btrim(p_summary), 4000)
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.abo_mcp_propose(uuid, text, jsonb, text) from public;
grant execute on function public.abo_mcp_propose(uuid, text, jsonb, text) to authenticated;

NOTIFY pgrst, 'reload schema';
