-- Migration 0035: what the design does NOT do, kept as its own field.
--
-- The card can rebuild every detail of a design from its plans — the
-- fields, the filters, the stats — so those need not be stored twice.
-- The one thing plans cannot say is what the merchant asked for and is
-- not getting. That line is the reason to read the card at all, and it
-- was only ever inside the rendered summary text, which meant the card
-- had to keep the whole block open to show it.
--
-- Callers: src/app/api/mcp/route.ts (propose_change) writes it,
-- src/components/ChatPanel.tsx reads it.

alter table public.build_requests
  add column if not exists unmet jsonb;

drop function if exists public.abo_mcp_propose(uuid, text, jsonb, text);

create or replace function public.abo_mcp_propose(
  p_project uuid,
  p_request text,
  p_plans   jsonb default null,
  p_summary text  default null,
  p_unmet   jsonb default null
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
    (project_id, requested_by, client_id, request, plans, summary, unmet)
  values (
    p_project,
    auth.uid(),
    nullif(auth.jwt() ->> 'client_id', ''),
    left(btrim(p_request), 2000),
    p_plans,
    left(btrim(p_summary), 4000),
    p_unmet
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.abo_mcp_propose(uuid, text, jsonb, text, jsonb) from public;
grant execute on function public.abo_mcp_propose(uuid, text, jsonb, text, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
