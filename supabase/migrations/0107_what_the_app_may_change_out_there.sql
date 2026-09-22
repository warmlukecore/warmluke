-- Migration 0107: a change asked for out there, and the yes it waits on.
--
-- Everything Warmluke does to Shopify today is read. This is the
-- first table for the other direction: one row per change somebody
-- wants made IN the merchant's store — a tag added, a note written,
-- a stock count set — and the record of whether it was allowed and
-- what came of it.
--
-- Deliberately the same shape as build_requests, because it is the
-- same story: an assistant proposes, a person agrees, the server
-- does it, and the outcome is written down. A second approval
-- mechanism with its own rules would be a second place to get this
-- wrong.
--
-- Three things this leans on rather than reinvents:
--
--   abo_owns(project_id)      who may see and answer for it
--   abo_is_oauth_client()     a token issued to somebody's AI
--   abo_feature('...')        the switch it is all behind
--
-- Nothing here can reach Shopify. The token this app holds carries
-- read scopes only, so until the app asks for write scopes and the
-- merchant reconnects, an approved row is a row that runs and is
-- refused by Shopify. That is on purpose: the whole path can be
-- built, merged and checked before it can touch anybody's store.
--
-- Callers (to come): src/lib/store-actions.ts, src/app/api/mcp/route.ts.

-- ── The switch ──────────────────────────────────────────────────
--
-- Off for everybody, including accounts that already have chat and
-- mcp on. The other two default to true because they were the
-- product; this one has to be turned on deliberately, per account,
-- after somebody has looked at it.
alter table public.account_settings
  add column if not exists store_actions_enabled boolean not null default false;

create or replace function public.abo_feature(p_name text)
returns boolean
language sql security definer set search_path = public stable as $$
  select case p_name
    when 'chat' then coalesce(
      (select chat_enabled from public.account_settings where user_id = auth.uid()), true)
    when 'mcp' then coalesce(
      (select mcp_enabled from public.account_settings where user_id = auth.uid()), true)
    -- Absent row means off, not on: a new account cannot write to a
    -- store before anyone has decided it may.
    when 'store_actions' then coalesce(
      (select store_actions_enabled from public.account_settings where user_id = auth.uid()), false)
    else false
  end
$$;

-- Rebuilt from 0074, not from 0032.
--
-- 0074 gave this an audit entry and a row lock; replacing it with
-- the older body would have taken both away, silently, for chat and
-- mcp as well. check-admin caught exactly that. Anything that
-- redefines a function has to start from the newest version of it,
-- and there is no way to know which that is except to look.
create or replace function public.abo_admin_set_feature(
  p_user    uuid,
  p_feature text,
  p_on      boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_before boolean;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_feature is null or p_feature not in ('chat', 'mcp', 'store_actions') or p_on is null then
    raise exception 'Unknown feature or state.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select case p_feature
           when 'chat' then chat_enabled
           when 'mcp' then mcp_enabled
           else store_actions_enabled
         end
    into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set chat_enabled          = case when p_feature = 'chat' then p_on else chat_enabled end,
         mcp_enabled           = case when p_feature = 'mcp'  then p_on else mcp_enabled end,
         store_actions_enabled = case when p_feature = 'store_actions' then p_on else store_actions_enabled end,
         updated_at            = now()
   where user_id = p_user;

  if v_before is distinct from p_on then
    insert into public.admin_account_audit (
      actor_user_id, target_user_id, action, old_value, new_value
    ) values (
      auth.uid(), p_user, 'set_feature',
      jsonb_build_object('feature', p_feature, 'enabled', v_before),
      jsonb_build_object('feature', p_feature, 'enabled', p_on)
    );
  end if;

  return p_on;
end $$;

-- ── The table ───────────────────────────────────────────────────
create table if not exists public.store_actions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  -- Which store. A project may have more than one connected, and an
  -- action that does not say which would be applied to whichever was
  -- found first.
  store_id     uuid not null references public.stores(id) on delete cascade,
  requested_by uuid not null,
  -- The assistant that asked, when it was not the merchant themselves.
  client_id    text,
  -- The registry key: what kind of change this is.
  action       text not null,
  -- Which rows out there it touches, by Shopify's own ids.
  targets      jsonb not null default '[]'::jsonb,
  -- What to set: the tag, the note, the count.
  params       jsonb not null default '{}'::jsonb,
  -- One line a person reads before they agree to it.
  summary      text not null,
  status       text not null default 'pending'
    check (status in ('pending', 'approved', 'running', 'done', 'partly_done', 'failed', 'dismissed')),
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid,
  ran_at       timestamptz,
  resolved_at  timestamptz,
  -- { done: [...], errors: [...] } — what Shopify actually accepted.
  outcome      jsonb
);

create index if not exists store_actions_project_status_idx
  on public.store_actions (project_id, status, created_at desc);

alter table public.store_actions enable row level security;

drop policy if exists store_actions_owner_read on public.store_actions;
create policy store_actions_owner_read on public.store_actions
  for select to authenticated using (public.abo_owns(project_id));

-- No owner insert or update policy on purpose. Everything that
-- writes here goes through the functions below, which are the only
-- place the rules live — a row somebody inserted at the table could
-- name any action, any target, and carry its own approved_at.
drop policy if exists store_actions_oauth_no_insert on public.store_actions;
create policy store_actions_oauth_no_insert on public.store_actions
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists store_actions_oauth_no_update on public.store_actions;
create policy store_actions_oauth_no_update on public.store_actions
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists store_actions_oauth_no_delete on public.store_actions;
create policy store_actions_oauth_no_delete on public.store_actions
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── Asking ──────────────────────────────────────────────────────
create or replace function public.abo_action_propose(
  p_project uuid,
  p_store   uuid,
  p_action  text,
  p_targets jsonb,
  p_params  jsonb,
  p_summary text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_client text := nullif(auth.jwt() ->> 'client_id', '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if not public.abo_feature('store_actions') then
    raise exception 'Changing the store from Warmluke is not turned on for this account.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.stores s
     where s.id = p_store and s.project_id = p_project and s.status = 'connected'
  ) then
    raise exception 'No connected store of theirs has that id.' using errcode = '22023';
  end if;
  if coalesce(trim(p_summary), '') = '' then
    raise exception 'An action nobody can read is an action nobody can agree to.'
      using errcode = '22023';
  end if;

  insert into public.store_actions
    (project_id, store_id, requested_by, client_id, action, targets, params, summary)
  values
    (p_project, p_store, auth.uid(), v_client, p_action,
     coalesce(p_targets, '[]'::jsonb), coalesce(p_params, '{}'::jsonb), trim(p_summary))
  returning id into v_id;
  return v_id;
end $$;

-- ── Agreeing ────────────────────────────────────────────────────
--
-- A client may never stamp this, and auto_build does not reach it.
--
-- auto_build is a standing yes the merchant gave to Warmluke
-- building sections inside their own app. Reading it here would
-- quietly widen a switch they flipped for something else into
-- permission to change their live store. If unattended store
-- changes are ever wanted they get their own switch, turned on by
-- somebody who knows that is what they are doing.
create or replace function public.abo_action_approve(p_action uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_n integer; v_client text := nullif(auth.jwt() ->> 'client_id', '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if v_client is not null then
    return jsonb_build_object(
      'approved', false,
      'reason', 'only the merchant approves a change to their store, in Warmluke'
    );
  end if;

  update public.store_actions a
     set status      = 'approved',
         approved_at = coalesce(a.approved_at, now()),
         approved_by = coalesce(a.approved_by, auth.uid())
   where a.id = p_action
     and public.abo_owns(a.project_id)
     and a.status = 'pending';
  get diagnostics v_n = row_count;

  return case when v_n > 0
    then jsonb_build_object('approved', true)
    else jsonb_build_object('approved', false, 'reason', 'no such change is waiting here')
  end;
end $$;

-- ── Doing it once ───────────────────────────────────────────────
--
-- The whole of idempotency. Two approvals arriving together, a
-- retried call, a second tab: the first one moves the row to
-- running and every other one is told it is already taken. Shopify
-- has no idempotency key to lean on for these mutations, so this is
-- the only thing between a merchant and two refunds.
create or replace function public.abo_action_claim(p_action uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row public.store_actions;
begin
  update public.store_actions a
     set status = 'running', ran_at = now()
   where a.id = p_action
     and public.abo_owns(a.project_id)
     and a.status = 'approved'
  returning a.* into v_row;

  if v_row.id is null then
    return jsonb_build_object(
      'claimed', false,
      'status', (select status from public.store_actions
                  where id = p_action and public.abo_owns(project_id))
    );
  end if;
  return jsonb_build_object(
    'claimed', true,
    'action', v_row.action,
    'store_id', v_row.store_id,
    'targets', v_row.targets,
    'params', v_row.params
  );
end $$;

-- ── What came of it ─────────────────────────────────────────────
create or replace function public.abo_action_done(
  p_action  uuid,
  p_outcome jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_done   integer := coalesce(jsonb_array_length(p_outcome -> 'done'), 0);
  v_errors integer := coalesce(jsonb_array_length(p_outcome -> 'errors'), 0);
  v_status text;
begin
  -- Said by the numbers, not by the caller. A caller that decides
  -- its own status is a caller that can report a failure as a
  -- success, and this row is the merchant's only record of what
  -- Warmluke did to their shop.
  v_status := case
    when v_errors = 0 and v_done > 0 then 'done'
    when v_done > 0 then 'partly_done'
    else 'failed'
  end;

  update public.store_actions a
     set status = v_status, outcome = p_outcome, resolved_at = now()
   where a.id = p_action
     and public.abo_owns(a.project_id)
     and a.status = 'running';

  return jsonb_build_object('status', v_status);
end $$;

-- ── Turning it down ─────────────────────────────────────────────
create or replace function public.abo_action_dismiss(p_action uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update public.store_actions a
     set status = 'dismissed', resolved_at = now()
   where a.id = p_action
     and public.abo_owns(a.project_id)
     and a.status in ('pending', 'approved');
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function public.abo_action_propose(uuid, uuid, text, jsonb, jsonb, text) from public;
revoke all on function public.abo_action_approve(uuid) from public;
revoke all on function public.abo_action_claim(uuid) from public;
revoke all on function public.abo_action_done(uuid, jsonb) from public;
revoke all on function public.abo_action_dismiss(uuid) from public;
grant execute on function public.abo_action_propose(uuid, uuid, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.abo_action_approve(uuid) to authenticated;
grant execute on function public.abo_action_claim(uuid) to authenticated;
grant execute on function public.abo_action_done(uuid, jsonb) to authenticated;
grant execute on function public.abo_action_dismiss(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
