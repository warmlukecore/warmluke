-- Migration 0032: two switches, because there were always two things.
--
-- 0027 called this "whose assistant" — ours or theirs — and that was
-- true while their own AI could only read. Now it can propose a change
-- and build an approved one, so the two are not alternatives any more:
-- an account can sensibly have both, either, or neither, and one enum
-- with two values cannot say that.
--
-- So the enum splits into the two things it was standing in for:
--   chat_enabled — the assistant inside Warmluke, which we pay for
--   mcp_enabled  — their own Claude or ChatGPT, which they pay for
--
-- Both default on. Turning chat off is a plan decision, not a broken
-- account, and it leaves the merchant a working app: their own AI can
-- still design and build, and a request that already carries a design
-- can be approved in the app without any model call at all.

alter table public.account_settings
  add column if not exists chat_enabled boolean not null default true,
  add column if not exists mcp_enabled  boolean not null default true;

-- Whatever the old column said, said in the new shape. 'theirs' meant
-- "no Warmluke chat", never "no MCP".
update public.account_settings
   set chat_enabled = (assistant <> 'theirs')
 where assistant is not null;

alter table public.account_settings drop column if exists assistant;

-- The shape of what it returns changed, so the old one goes first.
drop function if exists public.abo_my_settings();
create or replace function public.abo_my_settings()
returns table (chat_enabled boolean, mcp_enabled boolean, is_superadmin boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  return query
    select s.chat_enabled, s.mcp_enabled, s.is_superadmin
      from public.account_settings s
     where s.user_id = auth.uid();
end $$;

-- Read by the two API routes before they do any work, so a switch is
-- enforced where the money is spent rather than only in the UI.
create or replace function public.abo_feature(p_name text)
returns boolean
language sql security definer set search_path = public stable as $$
  select case p_name
    when 'chat' then coalesce(
      (select chat_enabled from public.account_settings where user_id = auth.uid()), true)
    when 'mcp' then coalesce(
      (select mcp_enabled from public.account_settings where user_id = auth.uid()), true)
    else false
  end
$$;

drop function if exists public.abo_admin_accounts();
create or replace function public.abo_admin_accounts()
returns table (
  user_id       uuid,
  email         text,
  chat_enabled  boolean,
  mcp_enabled   boolean,
  is_superadmin boolean,
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
      (select count(*) from public.projects p where p.owner_id = u.id),
      (select count(*) from public.stores st
         join public.projects p2 on p2.id = st.project_id
        where p2.owner_id = u.id and st.status = 'connected'),
      u.created_at
    from auth.users u
    left join public.account_settings s on s.user_id = u.id
    order by u.created_at desc;
end $$;

-- One switch at a time, named. A single call that took both would let
-- a stale admin screen turn one back on while flipping the other.
drop function if exists public.abo_admin_set_assistant(uuid, text);
create or replace function public.abo_admin_set_feature(
  p_user    uuid,
  p_feature text,
  p_on      boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_feature not in ('chat', 'mcp') then
    raise exception 'Unknown feature "%".', p_feature using errcode = '22023';
  end if;

  insert into public.account_settings (user_id, chat_enabled, mcp_enabled, updated_at)
  values (p_user, p_feature <> 'chat' or p_on, p_feature <> 'mcp' or p_on, now())
  on conflict (user_id) do update
    set chat_enabled = case when p_feature = 'chat' then p_on else account_settings.chat_enabled end,
        mcp_enabled  = case when p_feature = 'mcp'  then p_on else account_settings.mcp_enabled end,
        updated_at   = now();

  return p_on;
end $$;

revoke all on function public.abo_admin_accounts() from public;
revoke all on function public.abo_admin_set_feature(uuid, text, boolean) from public;
grant execute on function public.abo_my_settings() to authenticated;
grant execute on function public.abo_feature(text) to authenticated;
grant execute on function public.abo_admin_accounts() to authenticated;
grant execute on function public.abo_admin_set_feature(uuid, text, boolean) to authenticated;

NOTIFY pgrst, 'reload schema';
