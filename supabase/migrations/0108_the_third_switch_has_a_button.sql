-- Migration 0108: the third switch, where the other two already are.
--
-- 0107 made store_actions_enabled and taught abo_feature and
-- abo_admin_set_feature about it. What it did not do is give anyone
-- a way to turn it on: the admin screen reads abo_admin_accounts,
-- and that function still returns two switches, so the column
-- existed and nothing could reach it.
--
-- Rebuilt from 0074's body, which is the newest one — the same
-- mistake this session already made once, where a function was
-- replaced with an older version and an audit trail disappeared
-- with it.
--
-- Callers: src/app/admin/page.tsx.

drop function if exists public.abo_admin_accounts();
create or replace function public.abo_admin_accounts()
returns table (
  user_id               uuid,
  email                 text,
  chat_enabled          boolean,
  mcp_enabled           boolean,
  store_actions_enabled boolean,
  is_superadmin         boolean,
  free_turns            integer,
  turns_used            integer,
  turns_unlimited       boolean,
  projects              bigint,
  stores                bigint,
  created_at            timestamptz
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
      -- False for an account with no settings row, matching
      -- abo_feature: changing somebody's shop is not something a
      -- missing row should be read as permission for.
      coalesce(s.store_actions_enabled, false),
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

revoke all on function public.abo_admin_accounts() from public;
grant execute on function public.abo_admin_accounts() to authenticated;

NOTIFY pgrst, 'reload schema';
