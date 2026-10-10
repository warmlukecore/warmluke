-- Migration 0202: Luke test — meet Luke again, for the people let in
--
-- TEMPORARY, for trying the first meeting on the live app (10 Oct). An
-- administrator turns "Luke test" on for an account in the console; that
-- account can then open /luke-convo and meet Luke from the start again,
-- as often as they like. Goes with the page once testing is done (the
-- user's reminder): drop the column and the two functions, put 0200's
-- trigger and 0158's reader back.
--
-- - account_settings.luke_test: off for everyone, set only by an
--   administrator through abo_admin_set_luke_test, on the account's trail.
-- - abo_meet_luke_again(): for an account with it on (or an administrator):
--   their meeting threads gone, met_luke_at cleared, the free meeting
--   turns started over; returns their first app to open it in. 0200 lets
--   only the server clear met_luke_at; this function alone says so too,
--   for the one update it makes.

alter table public.account_settings add column if not exists luke_test boolean not null default false;

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete', 'set_luke',
             'set_tester', 'view_conversation', 'rename', 'set_columns', 'set_luke_test')
);

create or replace function public.abo_admin_set_luke_test(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_was boolean;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Change this in Warmluke itself.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'On or off.' using errcode = '22023';
  end if;
  insert into public.account_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  select luke_test into v_was from public.account_settings where user_id = p_user for update;
  if v_was is distinct from p_on then
    update public.account_settings set luke_test = p_on, updated_at = now() where user_id = p_user;
    insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
    values (auth.uid(), p_user, 'set_luke_test', jsonb_build_object('luke_test', v_was), jsonb_build_object('luke_test', p_on));
  end if;
  return p_on;
end $$;
revoke all on function public.abo_admin_set_luke_test(uuid, boolean) from public, anon;
grant execute on function public.abo_admin_set_luke_test(uuid, boolean) to authenticated;

-- 0158's reader for the account's dialog, saying whether Luke test is on.
create or replace function public.abo_admin_luke(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select jsonb_build_object('models', to_jsonb(luke_models), 'shows', luke_shows, 'tester', tester, 'luke_test', luke_test)
    into v_out
    from public.account_settings
   where user_id = p_user;
  return coalesce(v_out, jsonb_build_object('models', null, 'shows', 'nothing', 'tester', false, 'luke_test', false));
end $$;

-- 0200's touch, with the one way past it: abo_meet_luke_again's own update.
create or replace function public.abo_profiles_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and old.onboarded_at is not null then
    new.onboarded_at := old.onboarded_at;
  elsif new.onboarded_at is not null then
    new.onboarded_at := now();
  end if;
  -- The server alone may ask again (a test, or support showing someone the
  -- first conversation once more): a browser cannot take it back.
  if tg_op = 'UPDATE' and old.met_luke_at is not null and coalesce(auth.role(), '') <> 'service_role'
     and coalesce(current_setting('abo.meet_again', true), '') <> 'on' then
    new.met_luke_at := old.met_luke_at;
  elsif new.met_luke_at is not null then
    new.met_luke_at := now();
  end if;
  return new;
end $$;

create or replace function public.abo_meet_luke_again() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  if public.abo_is_oauth_client() then
    raise exception 'Open this in Warmluke itself.' using errcode = '42501';
  end if;
  if not (public.abo_is_superadmin()
          or coalesce((select s.luke_test from public.account_settings s where s.user_id = auth.uid()), false)) then
    raise exception 'Luke test isn’t on for this account. An administrator turns it on in the console.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = auth.uid() and onboarded_at is not null) then
    raise exception 'Finish setting up your store first.' using errcode = '22023';
  end if;
  select id into v_project from public.projects where owner_id = auth.uid() order by created_at limit 1;
  if v_project is null then
    raise exception 'You have no app of your own to meet Luke in.' using errcode = '22023';
  end if;
  delete from public.conversations c
   where c.project_id in (select id from public.projects where owner_id = auth.uid())
     and exists (select 1 from public.messages m where m.conversation_id = c.id and m.payload ->> 'kind' = 'meet');
  perform set_config('abo.meet_again', 'on', true);
  update public.profiles set met_luke_at = null where user_id = auth.uid();
  perform set_config('abo.meet_again', '', true);
  insert into public.account_settings (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update public.account_settings set meet_turns = 0, updated_at = now() where user_id = auth.uid();
  return v_project;
end $$;
revoke all on function public.abo_meet_luke_again() from public, anon;
grant execute on function public.abo_meet_luke_again() to authenticated;

NOTIFY pgrst, 'reload schema';
