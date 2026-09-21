-- Migration 0096: the follow-ups outlive the answer that carried them.
--
-- A design comes with up to two things worth doing next, in the
-- merchant's own words. The app has shown them on the receipt since
-- they were added. A connected assistant now gets them too — but only
-- on the answer to propose_change, because that is the only moment
-- they existed in memory.
--
-- The common path does not pass through that moment. With auto-build
-- off, the assistant proposes, the merchant says yes, and the build
-- happens inside approve_change, minutes or hours later, in a request
-- row that never held the follow-ups at all. So the merchants most
-- likely to want a nudge — the ones who read every design before
-- agreeing to it — were the ones who got none.
--
-- Kept beside the plans, which is where everything else about a
-- design already lives.
--
-- The old five-argument signature is dropped rather than left beside
-- this one: two functions of the same name, one of them matching any
-- call the other does, is how a caller starts reaching whichever the
-- planner prefers today. Callers that do not send p_next still work,
-- because it has a default.
--
-- Callers: src/app/api/mcp/route.ts — settleDesign writes them with
-- the request, approve_change reads them back when the build lands.

alter table public.build_requests add column if not exists next jsonb;

comment on column public.build_requests.next is
  'Up to two follow-ups the design offered, each {label, prompt}. Offered to the merchant, never acted on by anything.';

drop function if exists public.abo_mcp_propose(uuid, text, jsonb, text, jsonb);

create or replace function public.abo_mcp_propose(
  p_project uuid,
  p_request text,
  p_plans   jsonb default null,
  p_summary text  default null,
  p_unmet   jsonb default null,
  p_next    jsonb default null
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
  if p_plans is not null and jsonb_typeof(p_plans) <> 'array' then
    raise exception 'Plans must be a list.' using errcode = '22023';
  end if;
  if p_plans is not null and jsonb_array_length(p_plans) > 6 then
    raise exception 'Too many plans in one request.' using errcode = '22023';
  end if;
  if p_unmet is not null and jsonb_typeof(p_unmet) <> 'array' then
    raise exception 'Unmet must be a list.' using errcode = '22023';
  end if;
  -- Two at the most, the same ceiling the panel shows. A model that
  -- returned nine would otherwise fill a card with suggestions and
  -- bury the design they are meant to be reading.
  if p_next is not null and (jsonb_typeof(p_next) <> 'array' or jsonb_array_length(p_next) > 2) then
    raise exception 'Next steps must be a list of at most two.' using errcode = '22023';
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
    (project_id, requested_by, client_id, request, plans, summary, unmet, next)
  values (
    p_project,
    auth.uid(),
    nullif(auth.jwt() ->> 'client_id', ''),
    left(btrim(p_request), 2000),
    p_plans,
    left(btrim(p_summary), 4000),
    p_unmet,
    p_next
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.abo_mcp_propose(uuid, text, jsonb, text, jsonb, jsonb) from public;
grant execute on function public.abo_mcp_propose(uuid, text, jsonb, text, jsonb, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
