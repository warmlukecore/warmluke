-- An invite to start: a link an administrator sends a customer.
--
-- Anyone can sign up at /signup. An invite is for the customer an
-- administrator has already talked to: the link opens a sign-up with
-- what the administrator knew filled in (their email, name, business),
-- then onboarding with the same. It lasts 72 hours unless the
-- administrator says otherwise, and can be lengthened, shortened or
-- taken back from the admin screen; it is used once unless it was made
-- for several people.
--
-- The token is the only proof of invitation, 192 random bits, so it
-- cannot be guessed. The tables are closed (RLS on, nothing granted): an
-- administrator reads and writes them through functions that check who
-- is asking, and a visitor holding a link can only ask about that one
-- link (abo_invite_peek) and, once signed in, take it (abo_invite_claim).
--
-- An invite made for one email can only be taken by that email: a link
-- forwarded to somebody else does not let them in on it.
--
-- Callers: src/app/start/[token]/page.tsx (peek, claim),
-- src/app/admin/invites/page.tsx (the admin functions).

create table if not exists public.account_invites (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  email         text check (email is null or (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 320)),
  full_name     text check (full_name is null or length(btrim(full_name)) between 1 and 120),
  business_name text check (business_name is null or length(btrim(business_name)) between 1 and 160),
  -- For the administrator: where they met, what was promised.
  note          text check (note is null or length(note) <= 300),
  max_uses      integer not null default 1 check (max_uses between 1 and 1000),
  uses          integer not null default 0 check (uses >= 0),
  expires_at    timestamptz not null default now() + interval '72 hours',
  revoked_at    timestamptz,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  -- One link for one named person cannot be a link for many.
  constraint account_invites_one_email_one_use check (email is null or max_uses = 1)
);

create table if not exists public.account_invite_claims (
  invite_id  uuid not null references public.account_invites (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);

alter table public.account_invites enable row level security;
alter table public.account_invite_claims enable row level security;
revoke all on public.account_invites from anon, authenticated;
revoke all on public.account_invite_claims from anon, authenticated;

-- And the wall every table carries (0078): no write from an AI's token,
-- even if a grant ever opens these.
drop policy if exists account_invites_oauth_no_insert on public.account_invites;
create policy account_invites_oauth_no_insert on public.account_invites
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists account_invites_oauth_no_update on public.account_invites;
create policy account_invites_oauth_no_update on public.account_invites
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists account_invites_oauth_no_delete on public.account_invites;
create policy account_invites_oauth_no_delete on public.account_invites
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists account_invite_claims_oauth_no_insert on public.account_invite_claims;
create policy account_invite_claims_oauth_no_insert on public.account_invite_claims
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists account_invite_claims_oauth_no_update on public.account_invite_claims;
create policy account_invite_claims_oauth_no_update on public.account_invite_claims
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists account_invite_claims_oauth_no_delete on public.account_invite_claims;
create policy account_invite_claims_oauth_no_delete on public.account_invite_claims
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());


-- Where an invite stands, said once for every function below.
create or replace function public.abo_invite_state(i public.account_invites)
returns text
language sql stable set search_path = public as $$
  select case
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    when i.uses >= i.max_uses then 'used'
    else 'open'
  end
$$;

-- ── For whoever holds the link ──────────────────────────────

-- What the link says, and nothing about any other link. An invite that
-- is not open says only why.
create or replace function public.abo_invite_peek(p_token text)
returns table (state text, email text, full_name text, business_name text, expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare i public.account_invites;
begin
  select * into i from public.account_invites a where a.token = p_token;
  if not found then
    return query select 'unknown'::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  if public.abo_invite_state(i) <> 'open' then
    return query select public.abo_invite_state(i), null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  return query select 'open'::text, i.email, i.full_name, i.business_name, i.expires_at;
end $$;

revoke all on function public.abo_invite_peek(text) from public;
grant execute on function public.abo_invite_peek(text) to anon, authenticated;

-- Taking it, signed in. Taking it twice is taking it once. Returns what
-- onboarding can start from.
create or replace function public.abo_invite_claim(p_token text)
returns table (state text, full_name text, business_name text)
language plpgsql security definer set search_path = public as $$
declare
  i      public.account_invites;
  v_mail text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  -- Locked, so two people cannot both take the last use.
  select * into i from public.account_invites a where a.token = p_token for update;
  if not found then
    return query select 'unknown'::text, null::text, null::text;
    return;
  end if;

  if exists (select 1 from public.account_invite_claims c where c.invite_id = i.id and c.user_id = auth.uid()) then
    return query select 'claimed'::text, i.full_name, i.business_name;
    return;
  end if;
  -- Warmluke's own team opening a customer's link does not use it up.
  if public.abo_is_superadmin() then
    return query select 'staff'::text, null::text, null::text;
    return;
  end if;
  if public.abo_invite_state(i) <> 'open' then
    return query select public.abo_invite_state(i), null::text, null::text;
    return;
  end if;
  if i.email is not null and lower(i.email) <> v_mail then
    return query select 'someone_else'::text, null::text, null::text;
    return;
  end if;

  insert into public.account_invite_claims (invite_id, user_id) values (i.id, auth.uid());
  update public.account_invites set uses = uses + 1 where id = i.id;
  return query select 'claimed'::text, i.full_name, i.business_name;
end $$;

revoke all on function public.abo_invite_claim(text) from public, anon;
grant execute on function public.abo_invite_claim(text) to authenticated;

-- ── For an administrator ────────────────────────────────────

create or replace function public.abo_admin_invites()
returns table (
  id uuid, token text, email text, full_name text, business_name text, note text,
  max_uses integer, uses integer, expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz, state text, claimed_by jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return query
    select i.id, i.token, i.email, i.full_name, i.business_name, i.note,
           i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at,
           public.abo_invite_state(i),
           (select coalesce(jsonb_agg(jsonb_build_object('email', u.email::text, 'at', c.claimed_at) order by c.claimed_at), '[]'::jsonb)
              from public.account_invite_claims c join auth.users u on u.id = c.user_id
             where c.invite_id = i.id)
      from public.account_invites i
     order by i.created_at desc;
end $$;

revoke all on function public.abo_admin_invites() from public, anon;
grant execute on function public.abo_admin_invites() to authenticated;

create or replace function public.abo_admin_invite_create(
  p_email text, p_full_name text, p_business_name text, p_note text, p_hours integer, p_max_uses integer
) returns text
language plpgsql security definer set search_path = public as $$
declare v_token text;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 720 then
    raise exception 'An invite lasts between an hour and thirty days.' using errcode = '22023';
  end if;
  insert into public.account_invites (email, full_name, business_name, note, max_uses, expires_at, created_by)
  values (
    nullif(lower(btrim(coalesce(p_email, ''))), ''),
    nullif(btrim(coalesce(p_full_name, '')), ''),
    nullif(btrim(coalesce(p_business_name, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    coalesce(p_max_uses, 1),
    now() + make_interval(hours => p_hours),
    auth.uid()
  )
  returning token into v_token;
  return v_token;
end $$;

revoke all on function public.abo_admin_invite_create(text, text, text, text, integer, integer) from public, anon;
grant execute on function public.abo_admin_invite_create(text, text, text, text, integer, integer) to authenticated;

-- Lengthen or shorten (hours from now), or take back. One call, one change.
create or replace function public.abo_admin_invite_update(p_id uuid, p_hours integer, p_revoke boolean)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if coalesce(p_revoke, false) then
    update public.account_invites set revoked_at = coalesce(revoked_at, now()) where id = p_id returning expires_at into v_until;
  else
    if p_hours is null or p_hours not between 1 and 720 then
      raise exception 'An invite lasts between an hour and thirty days.' using errcode = '22023';
    end if;
    update public.account_invites
       set expires_at = now() + make_interval(hours => p_hours)
     where id = p_id and revoked_at is null
    returning expires_at into v_until;
  end if;
  if not found then
    raise exception 'No such invite, or it was taken back.' using errcode = 'P0002';
  end if;
  return v_until;
end $$;

revoke all on function public.abo_admin_invite_update(uuid, integer, boolean) from public, anon;
grant execute on function public.abo_admin_invite_update(uuid, integer, boolean) to authenticated;

NOTIFY pgrst, 'reload schema';
