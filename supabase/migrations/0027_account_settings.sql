-- Migration 0027: which assistant an account uses, and who may change it.
--
-- The setting is not "chat on or off". It is whose assistant this
-- account uses — ours, or their own through MCP. Naming it "disabled"
-- would have someone six months from now read a working account as a
-- broken one, and the second choice is a real product rather than an
-- absence.
--
-- It sits on the account rather than the project, because that is who
-- pays for the model calls and who would be switched over.
--
-- The superadmin flag lives in a table nothing in the app can write.
-- Row-level security is the only security model here, and an admin
-- screen reaching past it with a service-role key would end that — so
-- admin reads and writes go through security definer functions that
-- check the caller first, exactly like the OAuth callback does.

create table if not exists public.account_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  -- 'ours'   — the built-in assistant, paid for by us
  -- 'theirs' — they connect their own Claude or ChatGPT over MCP
  assistant     text not null default 'ours',
  is_superadmin boolean not null default false,
  updated_at    timestamptz not null default now(),
  constraint account_settings_assistant_allowed check (assistant in ('ours', 'theirs'))
);

alter table public.account_settings enable row level security;

-- Readable by its owner, never writable from the app: a merchant who
-- could write this row could make themselves a superadmin.
drop policy if exists "account_settings_own_read" on public.account_settings;
create policy "account_settings_own_read" on public.account_settings
  for select using (user_id = auth.uid());

-- The caller's own settings, created on first read so there is a row.
create or replace function public.abo_my_settings()
returns table (assistant text, is_superadmin boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  return query
    select s.assistant, s.is_superadmin
      from public.account_settings s
     where s.user_id = auth.uid();
end $$;

create or replace function public.abo_is_superadmin()
returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce(
    (select is_superadmin from public.account_settings where user_id = auth.uid()),
    false
  )
$$;

-- Every account, for the admin screen. Refuses rather than returning
-- nothing when the caller is not an admin: an empty list reads as "no
-- accounts yet", and whoever is debugging would chase the wrong thing.
create or replace function public.abo_admin_accounts()
returns table (
  user_id       uuid,
  email         text,
  assistant     text,
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
      coalesce(s.assistant, 'ours'),
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

-- Switches one account between our assistant and their own.
create or replace function public.abo_admin_set_assistant(
  p_user      uuid,
  p_assistant text
) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_assistant not in ('ours', 'theirs') then
    raise exception 'Unknown assistant "%".', p_assistant using errcode = '22023';
  end if;

  insert into public.account_settings (user_id, assistant, updated_at)
  values (p_user, p_assistant, now())
  on conflict (user_id) do update
    set assistant = excluded.assistant, updated_at = now();

  return p_assistant;
end $$;

revoke all on function public.abo_admin_accounts() from public;
revoke all on function public.abo_admin_set_assistant(uuid, text) from public;
grant execute on function public.abo_my_settings() to authenticated;
grant execute on function public.abo_is_superadmin() to authenticated;
grant execute on function public.abo_admin_accounts() to authenticated;
grant execute on function public.abo_admin_set_assistant(uuid, text) to authenticated;

NOTIFY pgrst, 'reload schema';
