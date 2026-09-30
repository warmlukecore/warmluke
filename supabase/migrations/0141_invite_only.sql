-- Invite only.
--
-- Anyone could make an account at /signup and start an app. Now a
-- switch decides, and an administrator turns it on from the invites
-- screen. On, a new account may start an app only if it came in on an
-- invite (account_invite_claims, 0119); an account made before the
-- switch went on keeps the door it had, and one that already owns an
-- app keeps building. Someone added to a team (a seat, 0017) still
-- joins and uses that app; starting one of their own is an invite.
--
-- The screens say so (sign-up, onboarding, the dashboard), but the
-- database is what refuses: supabase-js can make an account with the
-- public key from anywhere, so the rule is on the insert of a project,
-- not on a page.
--
-- Off by default, so nothing changes until someone turns it on, and
-- the check project, where every check makes accounts of its own,
-- stays open.
--
-- Signing in is never gated: without an account it simply fails, and a
-- customer on a new phone has to be able to find it. Only making an
-- app is.
--
-- And the early-access form (the landing page's, 0066) now asks for
-- the business's name as the invite does, so a request becomes an
-- invite without retyping it; the admin list says which already have one.
--
-- Callers: src/app/signup/page.tsx and src/app/login/page.tsx
-- (signup_gate), src/app/onboarding/page.tsx and src/app/dashboard/page.tsx
-- (abo_may_start_app), src/app/admin/invites/page.tsx
-- (abo_admin_set_invite_only), src/app/admin/demos/page.tsx
-- (abo_admin_demo_requests), scripts/check-invite-only.mjs.

create table if not exists public.signup_gate (
  -- One row, always.
  id                boolean primary key default true check (id),
  invite_only       boolean not null default false,
  -- When it last went on: accounts made before it keep the open door.
  invite_only_since timestamptz,
  changed_at        timestamptz not null default now(),
  changed_by        uuid
);
insert into public.signup_gate (id) values (true) on conflict (id) do nothing;

alter table public.signup_gate enable row level security;
-- Whether sign-up is open is what the sign-up page shows anyway.
revoke all on public.signup_gate from anon, authenticated;
grant select (invite_only) on public.signup_gate to anon, authenticated;
drop policy if exists signup_gate_anyone_reads on public.signup_gate;
create policy signup_gate_anyone_reads on public.signup_gate for select to anon, authenticated using (true);

drop policy if exists signup_gate_oauth_no_insert on public.signup_gate;
create policy signup_gate_oauth_no_insert on public.signup_gate
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists signup_gate_oauth_no_update on public.signup_gate;
create policy signup_gate_oauth_no_update on public.signup_gate
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists signup_gate_oauth_no_delete on public.signup_gate;
create policy signup_gate_oauth_no_delete on public.signup_gate
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── Who may start an app ─────────────────────────────────────

create or replace function public.abo_may_start_app() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    not coalesce((select g.invite_only from public.signup_gate g), false)
    or public.abo_is_superadmin()
    or exists (select 1 from public.account_invite_claims c where c.user_id = auth.uid())
    or exists (select 1 from public.projects p where p.owner_id = auth.uid())
    or exists (select 1 from auth.users u, public.signup_gate g
                where u.id = auth.uid() and u.created_at < g.invite_only_since)
  );
$$;
revoke all on function public.abo_may_start_app() from public, anon;
grant execute on function public.abo_may_start_app() to authenticated;

drop policy if exists projects_invited_insert on public.projects;
create policy projects_invited_insert on public.projects
  as restrictive for insert to authenticated
  with check (public.abo_may_start_app());

-- ── Turning it on and off ────────────────────────────────────

create or replace function public.abo_admin_set_invite_only(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  update public.signup_gate
     set invite_only = p_on,
         invite_only_since = case when p_on and not invite_only then now() else invite_only_since end,
         changed_at = now(),
         changed_by = auth.uid()
   where id;
  return p_on;
end $$;
revoke all on function public.abo_admin_set_invite_only(boolean) from public, anon;
grant execute on function public.abo_admin_set_invite_only(boolean) to authenticated;

-- ── The requests, with the business and whether it has its invite ─
-- 0120's body, with two columns after it.
drop function if exists public.abo_admin_demo_requests();
create or replace function public.abo_admin_demo_requests()
returns table (
  id                uuid,
  created_at        timestamptz,
  name              text,
  email             text,
  store             text,
  note              text,
  team_size         text,
  monthly_orders    text,
  heard_from        text,
  heard_from_detail text,
  variant           text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  has_account       boolean,
  stage             text,
  follow_up_note    text,
  followed_up_at    timestamptz,
  followed_up_by    text,
  business          text,
  invited_at        timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;

  return query
    select
      e.id,
      e.created_at,
      e.payload->>'name',
      e.payload->>'email',
      e.payload->>'store',
      nullif(e.payload->>'note', ''),
      e.payload->>'team_size',
      e.payload->>'monthly_orders',
      e.payload->>'heard_from',
      nullif(e.payload->>'heard_from_detail', ''),
      e.variant,
      e.utm_source,
      e.utm_medium,
      e.utm_campaign,
      exists (
        select 1 from auth.users u
         where lower(u.email) = lower(btrim(e.payload->>'email'))
      ),
      coalesce(f.stage, 'new'),
      f.note,
      f.updated_at,
      fu.email::text,
      nullif(btrim(e.payload->>'business'), ''),
      (select max(i.created_at) from public.account_invites i
        where lower(i.email) = lower(btrim(e.payload->>'email')))
    from public.landing_events e
    left join public.demo_followups f on f.event_id = e.id
    left join auth.users fu on fu.id = f.updated_by
    where e.event = 'demo_booked'
    order by e.created_at desc;
end $$;

revoke all on function public.abo_admin_demo_requests() from public, anon;
grant execute on function public.abo_admin_demo_requests() to authenticated;

NOTIFY pgrst, 'reload schema';
