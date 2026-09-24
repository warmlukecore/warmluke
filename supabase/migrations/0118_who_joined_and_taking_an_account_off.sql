-- Who joined, in their own words; and taking an account off, gently or for good.
--
-- A person invited into somebody's app skips onboarding (it asks about a
-- business they do not run), so the accounts screen knew nothing of them:
-- an address and "hasn't answered yet". Now the seat they took carries
-- their name and what they do on the team, written by them when they
-- join, and the accounts screen shows whose app they are in and who
-- invited them.
--
-- And an administrator can take an account off, two ways:
--
--   Suspend   they cannot sign in, and every session they had ends. All
--             their data stays; Restore undoes it. A token already in a
--             browser runs out on its own, within the hour.
--   Delete    for good: their account, and every app they own with all
--             it holds, stores and their tokens included. Only an account
--             already suspended, and only with its email typed back, so
--             nobody is erased by a slip. Apps they only joined lose a
--             member, not their data.
--
-- Neither touches the administrator's own account or another
-- administrator's; an administrator is demoted first, on purpose. Both
-- are written to the audit trail, which has no foreign key to the account
-- and so outlives it.
--
-- ponytail: the delete runs in one request, under the database's request
-- timeout. A store of hundreds of thousands of rows could outlast it; the
-- delete then rolls back whole, and would need doing in steps.
--
-- Callers: src/app/join/[token]/page.tsx (abo_member_about),
-- src/components/ProjectSettings.tsx (the seats), src/app/admin/page.tsx
-- (abo_admin_accounts, abo_admin_suspend, abo_admin_delete_account).

-- ── Who joined ───────────────────────────────────────────────

alter table public.project_members
  add column if not exists full_name text
    check (full_name is null or length(btrim(full_name)) between 1 and 120),
  add column if not exists team_role text
    check (team_role is null or team_role in (
      'operations', 'customer_support', 'warehouse', 'finance', 'marketing', 'other'));

comment on column public.project_members.full_name is 'What the person who took this seat is called, in their words.';
comment on column public.project_members.team_role is 'What they do on the team; the list matches src/lib/onboarding.ts MEMBER_ROLE_OPTIONS.';

-- Their own seat only. The owner already manages seats through the table.
create or replace function public.abo_member_about(p_project uuid, p_name text, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  update public.project_members
     set full_name = nullif(btrim(coalesce(p_name, '')), ''),
         team_role = nullif(btrim(coalesce(p_role, '')), '')
   where project_id = p_project and user_id = auth.uid();
  if not found then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
end $$;

revoke all on function public.abo_member_about(uuid, text, text) from public, anon;
grant execute on function public.abo_member_about(uuid, text, text) to authenticated;

-- ── Taking an account off ───────────────────────────────────

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete')
);

-- The rules both actions share, said once.
create or replace function public.abo_admin_may_manage(p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Not your own account.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'No such account.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.account_settings where user_id = p_user and is_superadmin) then
    raise exception 'Another administrator is not taken off from here.' using errcode = '42501';
  end if;
end $$;

revoke all on function public.abo_admin_may_manage(uuid) from public, anon;
grant execute on function public.abo_admin_may_manage(uuid) to authenticated;

create or replace function public.abo_admin_suspend(p_user uuid, p_on boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_was boolean;
begin
  perform public.abo_admin_may_manage(p_user);
  if p_on is null then
    raise exception 'Suspend or restore, not neither.' using errcode = '22023';
  end if;

  select coalesce(banned_until > now(), false) into v_was from auth.users where id = p_user for update;

  -- A date a century out rather than infinity: the auth service reads it
  -- as a time, and not every reader of a time can hold infinity.
  update auth.users
     set banned_until = case when p_on then now() + interval '100 years' else null end
   where id = p_user;
  if p_on then
    delete from auth.sessions where user_id = p_user;
  end if;

  if v_was is distinct from p_on then
    insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
    values (auth.uid(), p_user, case when p_on then 'suspend' else 'restore' end,
            jsonb_build_object('suspended', v_was), jsonb_build_object('suspended', p_on));
  end if;
  return p_on;
end $$;

revoke all on function public.abo_admin_suspend(uuid, boolean) from public, anon;
grant execute on function public.abo_admin_suspend(uuid, boolean) to authenticated;

create or replace function public.abo_admin_delete_account(p_user uuid, p_email text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_email    text;
  v_banned   timestamptz;
  v_projects jsonb;
  v_n        integer;
begin
  perform public.abo_admin_may_manage(p_user);

  select email, banned_until into v_email, v_banned from auth.users where id = p_user for update;
  if v_banned is null or v_banned <= now() then
    raise exception 'Suspend the account before deleting it.' using errcode = '55000';
  end if;
  if lower(btrim(coalesce(p_email, ''))) is distinct from lower(v_email) then
    raise exception 'That is not this account''s email.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(name order by created_at), '[]'::jsonb) into v_projects
    from public.projects where owner_id = p_user;

  -- The one reference that does not cascade: a request they approved in
  -- somebody else's app keeps its history, without their name on it.
  update public.build_requests set approved_by = null where approved_by = p_user;

  delete from public.projects where owner_id = p_user;
  get diagnostics v_n = row_count;

  insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
  values (auth.uid(), p_user, 'delete',
          jsonb_build_object('email', v_email, 'projects', v_projects),
          jsonb_build_object('deleted', true));

  -- Their profile, settings, seats, sessions and connected assistants go
  -- with the account itself.
  delete from auth.users where id = p_user;
  return v_n;
end $$;

revoke all on function public.abo_admin_delete_account(uuid, text) from public, anon;
grant execute on function public.abo_admin_delete_account(uuid, text) to authenticated;

-- ── The accounts screen, with both ──────────────────────────
-- Rebuilt from 0112's body, the newest, with two columns after it.

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
  created_at            timestamptz,
  full_name             text,
  business_name         text,
  role                  text,
  monthly_orders        text,
  platform              text,
  website               text,
  team_size             text,
  heard_from            text,
  heard_from_detail     text,
  onboarded_at          timestamptz,
  last_sign_in_at       timestamptz,
  suspended             boolean,
  -- The apps they were invited into: whose, and what they said they do there.
  memberships           jsonb
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
      coalesce(s.store_actions_enabled, false),
      coalesce(s.is_superadmin, false),
      coalesce(s.free_turns, 10),
      coalesce(s.turns_used, 0),
      coalesce(s.turns_unlimited, false),
      (select count(*) from public.projects p where p.owner_id = u.id),
      (select count(*) from public.stores st
         join public.projects p2 on p2.id = st.project_id
        where p2.owner_id = u.id and st.status = 'connected'),
      u.created_at,
      pr.full_name,
      pr.business_name,
      pr.role,
      pr.monthly_orders,
      pr.platform,
      pr.website,
      pr.team_size,
      pr.heard_from,
      pr.heard_from_detail,
      pr.onboarded_at,
      u.last_sign_in_at,
      coalesce(u.banned_until > now(), false),
      (select coalesce(jsonb_agg(jsonb_build_object(
                'project', p3.name, 'owner', ou.email::text,
                'name', m.full_name, 'role', m.team_role, 'joined_at', m.joined_at)
              order by m.joined_at), '[]'::jsonb)
         from public.project_members m
         join public.projects p3 on p3.id = m.project_id
         left join auth.users ou on ou.id = p3.owner_id
        where m.user_id = u.id)
    from auth.users u
    left join public.account_settings s on s.user_id = u.id
    left join public.profiles pr on pr.user_id = u.id
    order by u.created_at desc;
end $$;

revoke all on function public.abo_admin_accounts() from public;
grant execute on function public.abo_admin_accounts() to authenticated;

NOTIFY pgrst, 'reload schema';
