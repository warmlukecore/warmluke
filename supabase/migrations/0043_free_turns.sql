-- Migration 0043: what Warmluke's own assistant costs us.
--
-- Counted per account, and counted where the money goes. The money
-- goes on engine turns, not on chat messages: propose_change runs the
-- same engine on the same key, so a merchant who connects their own
-- Claude is still spending ours every time it designs something. A
-- quota on the chat box alone would have capped nothing.
--
-- One turn is not one call either — a design, up to two repairs, and
-- the pass that works out what the design misses. Two to four calls
-- for one number on this counter.
--
-- The count only goes up. It deliberately does not live in messages:
-- deleting a conversation would refund the prompts it used.
--
-- Callers: src/app/api/chat/route.ts, src/app/api/mcp/route.ts.

alter table public.account_settings
  add column if not exists free_turns integer not null default 10,
  add column if not exists turns_used integer not null default 0;

comment on column public.account_settings.free_turns is
  'Engine turns this account may spend on our model. Raise it to grant more.';

-- Spends one, or says there are none left.
--
-- Charged before the model runs, because a client in a loop should
-- pay for its own stop. A turn that fails validation is refunded by
-- the caller — that is our bug, not their prompt.
create or replace function public.abo_spend_turn()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer; v_free integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  select turns_used, free_turns into v_used, v_free
    from public.account_settings where user_id = auth.uid();

  if v_used >= v_free then
    return jsonb_build_object('ok', false, 'used', v_used, 'free', v_free);
  end if;

  update public.account_settings
     set turns_used = turns_used + 1, updated_at = now()
   where user_id = auth.uid();

  return jsonb_build_object('ok', true, 'used', v_used + 1, 'free', v_free);
end $$;

-- Gives one back, when the engine could not produce a design it
-- trusts. The merchant asked once and got nothing; charging for that
-- is charging for our own failure.
create or replace function public.abo_refund_turn()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_used integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.account_settings
     set turns_used = greatest(turns_used - 1, 0), updated_at = now()
   where user_id = auth.uid()
  returning turns_used into v_used;
  return coalesce(v_used, 0);
end $$;

-- The merchant can see where they stand; only the functions above
-- change it.
drop function if exists public.abo_my_settings();
create or replace function public.abo_my_settings()
returns table (
  chat_enabled  boolean,
  mcp_enabled   boolean,
  is_superadmin boolean,
  free_turns    integer,
  turns_used    integer
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
    select s.chat_enabled, s.mcp_enabled, s.is_superadmin, s.free_turns, s.turns_used
      from public.account_settings s
     where s.user_id = auth.uid();
end $$;

revoke all on function public.abo_spend_turn() from public;
revoke all on function public.abo_refund_turn() from public;
grant execute on function public.abo_spend_turn() to authenticated;
grant execute on function public.abo_refund_turn() to authenticated;
grant execute on function public.abo_my_settings() to authenticated;

-- The admin screen shows where each account stands, and can grant
-- more. A quota only a database console can move is a quota that
-- turns every trial extension into an engineering task.
drop function if exists public.abo_admin_accounts();
create or replace function public.abo_admin_accounts()
returns table (
  user_id       uuid,
  email         text,
  chat_enabled  boolean,
  mcp_enabled   boolean,
  is_superadmin boolean,
  free_turns    integer,
  turns_used    integer,
  projects      bigint,
  stores        bigint,
  created_at    timestamptz
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
      (select count(*) from public.projects p where p.owner_id = u.id),
      (select count(*) from public.stores st
         join public.projects p2 on p2.id = st.project_id
        where p2.owner_id = u.id and st.status = 'connected'),
      u.created_at
    from auth.users u
    left join public.account_settings s on s.user_id = u.id
    order by u.created_at desc;
end $$;

create or replace function public.abo_admin_set_turns(
  p_user  uuid,
  p_turns integer
) returns integer
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_turns is null or p_turns < 0 or p_turns > 10000 then
    raise exception 'That is not an allowance.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id, free_turns, updated_at)
  values (p_user, p_turns, now())
  on conflict (user_id) do update
    set free_turns = excluded.free_turns, updated_at = now();

  return p_turns;
end $$;

revoke all on function public.abo_admin_accounts() from public;
revoke all on function public.abo_admin_set_turns(uuid, integer) from public;
grant execute on function public.abo_admin_accounts() to authenticated;
grant execute on function public.abo_admin_set_turns(uuid, integer) to authenticated;

NOTIFY pgrst, 'reload schema';
