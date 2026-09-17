-- Migration 0074: an allowance can be unlimited, and every hand on
-- the admin controls leaves a receipt.
--
-- Unlimited is a separate fact, not a magic number and not a NULL
-- free_turns. The finite ceiling stays meaningful while unlimited is
-- on, so switching it off restores the allowance the admin last set.
-- It also keeps every existing reader's integer contract intact.
--
-- turns_used is a lifetime count. Raising free_turns is usually the
-- right way to grant more, but it cannot start a genuinely fresh
-- allowance when the count is already above the new ceiling. Reset is
-- therefore a separate, conspicuous operation rather than a side
-- effect of changing the ceiling.
--
-- Callers: src/app/admin/page.tsx, src/components/ChatPanel.tsx,
-- src/app/api/chat/route.ts, src/app/api/mcp/route.ts,
-- scripts/check-admin.mjs.

alter table public.account_settings
  add column if not exists turns_unlimited boolean not null default false;

comment on column public.account_settings.turns_unlimited is
  'When true, Warmluke designs do not stop at free_turns. The finite ceiling is retained for when this is disabled.';

-- Append-only from the application. There is deliberately no direct
-- policy for reading or writing this table: the SECURITY DEFINER admin
-- functions below are its only writers, and the database console can
-- inspect it when an incident or support question needs a timeline.
create table if not exists public.admin_account_audit (
  id              bigint generated always as identity primary key,
  actor_user_id   uuid not null,
  target_user_id  uuid not null,
  action          text not null,
  old_value       jsonb not null,
  new_value       jsonb not null,
  created_at      timestamptz not null default now(),
  constraint admin_account_audit_action_allowed check (
    action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns')
  )
);

comment on table public.admin_account_audit is
  'Append-only record of account controls changed by a superadmin.';

alter table public.admin_account_audit enable row level security;

-- Keep the cross-table OAuth guard complete for every new public
-- table. These are restrictive and grant no access on their own; this
-- table intentionally has no permissive client policy at all.
create policy "admin_account_audit_oauth_no_insert"
  on public.admin_account_audit as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

create policy "admin_account_audit_oauth_no_update"
  on public.admin_account_audit as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

create policy "admin_account_audit_oauth_no_delete"
  on public.admin_account_audit as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

revoke all on table public.admin_account_audit from public, anon, authenticated;
revoke all on sequence public.admin_account_audit_id_seq from public, anon, authenticated;

-- The merchant can see both the retained finite ceiling and whether
-- that ceiling currently applies.
drop function if exists public.abo_my_settings();
create or replace function public.abo_my_settings()
returns table (
  chat_enabled    boolean,
  mcp_enabled     boolean,
  is_superadmin   boolean,
  free_turns      integer,
  turns_used      integer,
  turns_unlimited boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  return query
    select s.chat_enabled, s.mcp_enabled, s.is_superadmin,
           s.free_turns, s.turns_used, s.turns_unlimited
      from public.account_settings s
     where s.user_id = auth.uid();
end $$;

-- The limit decision remains inside one conditional UPDATE. PostgreSQL
-- locks and rechecks this predicate, so concurrent capped spends cannot
-- both claim the final design; unlimited merely adds a second valid
-- branch to that same atomic guard.
create or replace function public.abo_spend_turn()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_used integer;
  v_free integer;
  v_unlimited boolean;
  v_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  update public.account_settings
     set turns_used     = turns_used + 1,
         last_spend_at  = now(),
         last_spend_id  = v_id,
         last_refund_at = null,
         updated_at     = now()
   where user_id = auth.uid()
     and (turns_unlimited or turns_used < free_turns)
  returning turns_used, free_turns, turns_unlimited
       into v_used, v_free, v_unlimited;

  if v_used is null then
    select turns_used, free_turns, turns_unlimited
      into v_used, v_free, v_unlimited
      from public.account_settings
     where user_id = auth.uid();
    return jsonb_build_object(
      'ok', false, 'used', v_used, 'free', v_free,
      'unlimited', v_unlimited
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'used', v_used, 'free', v_free,
    'unlimited', v_unlimited, 'spend_id', v_id
  );
end $$;

-- Every account for the admin screen. A caller who is not a
-- superadmin gets 42501 before auth.users is touched.
drop function if exists public.abo_admin_accounts();
create or replace function public.abo_admin_accounts()
returns table (
  user_id         uuid,
  email           text,
  chat_enabled    boolean,
  mcp_enabled     boolean,
  is_superadmin   boolean,
  free_turns      integer,
  turns_used      integer,
  turns_unlimited boolean,
  projects        bigint,
  stores          bigint,
  created_at      timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;

  return query
    select
      u.id,
      u.email::text,
      coalesce(s.chat_enabled, true),
      coalesce(s.mcp_enabled, true),
      coalesce(s.is_superadmin, false),
      coalesce(s.free_turns, 10),
      coalesce(s.turns_used, 0),
      coalesce(s.turns_unlimited, false),
      (select count(*) from public.projects p where p.owner_id = u.id),
      (select count(*) from public.stores st
         join public.projects p2 on p2.id = st.project_id
        where p2.owner_id = u.id and st.status = 'connected'),
      u.created_at
    from auth.users u
    left join public.account_settings s on s.user_id = u.id
    order by u.created_at desc;
end $$;

-- One switch at a time. Locking the settings row makes the before and
-- after values in the audit entry describe the write that actually won.
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
  if p_feature is null or p_feature not in ('chat', 'mcp') or p_on is null then
    raise exception 'Unknown feature or state.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select case when p_feature = 'chat' then chat_enabled else mcp_enabled end
    into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set chat_enabled = case when p_feature = 'chat' then p_on else chat_enabled end,
         mcp_enabled  = case when p_feature = 'mcp'  then p_on else mcp_enabled end,
         updated_at   = now()
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

-- A finite ceiling may use the full non-negative PostgreSQL integer
-- range. Unlimited has its own switch, so no magic maximum is needed.
create or replace function public.abo_admin_set_turns(
  p_user  uuid,
  p_turns integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_before integer;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_turns is null or p_turns < 0 then
    raise exception 'That is not an allowance.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select free_turns into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set free_turns = p_turns, updated_at = now()
   where user_id = p_user;

  if v_before is distinct from p_turns then
    insert into public.admin_account_audit (
      actor_user_id, target_user_id, action, old_value, new_value
    ) values (
      auth.uid(), p_user, 'set_turns',
      jsonb_build_object('free_turns', v_before),
      jsonb_build_object('free_turns', p_turns)
    );
  end if;

  return p_turns;
end $$;

create or replace function public.abo_admin_set_unlimited(
  p_user uuid,
  p_on   boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_before boolean;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'That is not an unlimited state.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select turns_unlimited into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set turns_unlimited = p_on, updated_at = now()
   where user_id = p_user;

  if v_before is distinct from p_on then
    insert into public.admin_account_audit (
      actor_user_id, target_user_id, action, old_value, new_value
    ) values (
      auth.uid(), p_user, 'set_unlimited',
      jsonb_build_object('turns_unlimited', v_before),
      jsonb_build_object('turns_unlimited', p_on)
    );
  end if;

  return p_on;
end $$;

create or replace function public.abo_admin_reset_turns(p_user uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_before integer;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select turns_used into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set turns_used = 0,
         last_spend_at = null,
         last_spend_id = null,
         last_refund_at = null,
         updated_at = now()
   where user_id = p_user;

  if v_before is distinct from 0 then
    insert into public.admin_account_audit (
      actor_user_id, target_user_id, action, old_value, new_value
    ) values (
      auth.uid(), p_user, 'reset_turns',
      jsonb_build_object('turns_used', v_before),
      jsonb_build_object('turns_used', 0)
    );
  end if;

  return 0;
end $$;

revoke all on function public.abo_my_settings() from public;
revoke all on function public.abo_spend_turn() from public;
revoke all on function public.abo_admin_accounts() from public;
revoke all on function public.abo_admin_set_feature(uuid, text, boolean) from public;
revoke all on function public.abo_admin_set_turns(uuid, integer) from public;
revoke all on function public.abo_admin_set_unlimited(uuid, boolean) from public;
revoke all on function public.abo_admin_reset_turns(uuid) from public;

grant execute on function public.abo_my_settings() to authenticated;
grant execute on function public.abo_spend_turn() to authenticated;
grant execute on function public.abo_admin_accounts() to authenticated;
grant execute on function public.abo_admin_set_feature(uuid, text, boolean) to authenticated;
grant execute on function public.abo_admin_set_turns(uuid, integer) to authenticated;
grant execute on function public.abo_admin_set_unlimited(uuid, boolean) to authenticated;
grant execute on function public.abo_admin_reset_turns(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
