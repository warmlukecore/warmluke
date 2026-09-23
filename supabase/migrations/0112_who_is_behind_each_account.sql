-- Who is behind each account: what they told us when they joined.
--
-- Its own table, not auth.users. That one belongs to Supabase's auth,
-- and the part of it an app may write — user_metadata — can be changed
-- by the person from their browser with no check at all: fine for a
-- display name, not for the answers the accounts screen reads. Here a
-- person writes only their own row, the values are held to the same
-- lists the form offers, and the administrator reads them through the
-- one function that already checks who is asking.
--
-- One row per account, keyed by the account itself, so there can never
-- be a second; it goes when the account goes.
--
-- The lists match src/lib/onboarding.ts, and check-onboarding compares
-- the two so neither can drift.
--
-- Callers: src/app/onboarding/page.tsx (own row), src/app/dashboard/page.tsx
-- (whether onboarding is finished), src/app/admin/page.tsx (everyone's,
-- via abo_admin_accounts).

create table if not exists public.profiles (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  full_name         text not null check (length(btrim(full_name)) between 1 and 120),
  business_name     text not null check (length(btrim(business_name)) between 1 and 160),
  role              text not null check (role in (
                      'founder', 'operations', 'ecommerce', 'customer_experience',
                      'technology', 'finance', 'other')),
  monthly_orders    text not null check (monthly_orders in (
                      'under_500', '500_2000', '2001_5000', '5001_10000',
                      '10001_25000', 'above_25000', 'undisclosed')),
  platform          text not null check (platform in (
                      'shopify', 'shopify_plus', 'woocommerce', 'magento',
                      'custom', 'multiple', 'other')),
  website           text check (website is null or length(website) between 1 and 200),
  team_size         text check (team_size is null or team_size in (
                      'just_me', '2_5', '6_20', '21_50', '51_200', 'above_200')),
  heard_from        text check (heard_from is null or heard_from in (
                      'referral', 'twitter', 'linkedin', 'instagram', 'youtube',
                      'search', 'shopify_app_store', 'event', 'other')),
  heard_from_detail text check (heard_from_detail is null or length(heard_from_detail) between 1 and 200),
  -- Set once, when they finish; onboarding is not shown again after.
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_own_read on public.profiles;
create policy profiles_own_read on public.profiles
  for select to authenticated using (user_id = auth.uid());
drop policy if exists profiles_own_insert on public.profiles;
create policy profiles_own_insert on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No delete: the row goes with the account.

-- The wall every table has: nothing written from a connected AI's token.
drop policy if exists profiles_oauth_no_insert on public.profiles;
create policy profiles_oauth_no_insert on public.profiles
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists profiles_oauth_no_update on public.profiles;
create policy profiles_oauth_no_update on public.profiles
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists profiles_oauth_no_delete on public.profiles;
create policy profiles_oauth_no_delete on public.profiles
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

-- updated_at is the database's to keep, and onboarded_at is only ever
-- "now", set once: a browser cannot backdate it, and a later edit of
-- the answers does not un-finish anybody.
create or replace function public.abo_profiles_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and old.onboarded_at is not null then
    new.onboarded_at := old.onboarded_at;
  elsif new.onboarded_at is not null then
    new.onboarded_at := now();
  end if;
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before insert or update on public.profiles
  for each row execute function public.abo_profiles_touch();

-- The accounts screen, with the answers beside each account. Rebuilt
-- from 0108's body, the newest, with the profile columns added after it.
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
  last_sign_in_at       timestamptz
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
      u.last_sign_in_at
    from auth.users u
    left join public.account_settings s on s.user_id = u.id
    left join public.profiles pr on pr.user_id = u.id
    order by u.created_at desc;
end $$;

revoke all on function public.abo_admin_accounts() from public;
grant execute on function public.abo_admin_accounts() to authenticated;

NOTIFY pgrst, 'reload schema';
