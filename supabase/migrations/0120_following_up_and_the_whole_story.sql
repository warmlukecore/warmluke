-- Following up a demo request, and the whole story of one account.
--
-- A demo request was a row and nothing after it: no way to say that
-- somebody had written back, booked a call, or that it came to nothing.
-- demo_followups is that, one row per request: where it stands, and a
-- note only administrators read. It is its own table because the
-- request's row is written by strangers holding the public key; a stage
-- kept on that row would be theirs to set.
--
-- Two administrators can have the same request open. A save says which
-- version it was made against, and one made against an older version is
-- refused rather than quietly writing over the other's note.
--
-- abo_admin_account is what the accounts screen opens for one person:
-- the apps they own with each one's stores, the invite they came in
-- through (0119), the demos they asked for, and what administrators have
-- done to the account, newest first. Never a store's tokens.
--
-- Callers: src/app/admin/demos/page.tsx, src/components/AccountDetail.tsx.

create table if not exists public.demo_followups (
  event_id   uuid primary key references public.landing_events (id) on delete cascade,
  stage      text not null default 'new'
             check (stage in ('new', 'contacted', 'scheduled', 'customer', 'not_a_fit')),
  note       text check (char_length(note) <= 4000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.demo_followups enable row level security;
revoke all on public.demo_followups from anon, authenticated;

-- And the wall every table carries (0078).
drop policy if exists demo_followups_oauth_no_insert on public.demo_followups;
create policy demo_followups_oauth_no_insert on public.demo_followups
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists demo_followups_oauth_no_update on public.demo_followups;
create policy demo_followups_oauth_no_update on public.demo_followups
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists demo_followups_oauth_no_delete on public.demo_followups;
create policy demo_followups_oauth_no_delete on public.demo_followups
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── Saying where a request stands ───────────────────────────
-- p_seen: the followed_up_at the screen was showing, null when it had
-- none. Returns the new one, for the screen's next save.
create or replace function public.abo_admin_demo_follow_up(
  p_id    uuid,
  p_stage text,
  p_note  text,
  p_seen  timestamptz
)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('new', 'contacted', 'scheduled', 'customer', 'not_a_fit') then
    raise exception 'Not a stage: %', p_stage using errcode = '22023';
  end if;
  if not exists (select 1 from public.landing_events where id = p_id and event = 'demo_booked') then
    raise exception 'No such demo request.' using errcode = 'P0002';
  end if;

  -- Written only over the version the screen saw: the first save only
  -- when there is none, a later one only when it is still that one. Two
  -- saves at once cannot both pass, whichever comes second.
  if p_seen is null then
    insert into public.demo_followups (event_id, stage, note, updated_by, updated_at)
    values (p_id, p_stage, nullif(btrim(p_note), ''), auth.uid(), clock_timestamp())
    on conflict (event_id) do nothing
    returning updated_at into v_at;
  else
    update public.demo_followups
       set stage = p_stage, note = nullif(btrim(p_note), ''),
           updated_by = auth.uid(), updated_at = clock_timestamp()
     where event_id = p_id and updated_at = p_seen
    returning updated_at into v_at;
  end if;
  if v_at is null then
    -- PT409: PostgREST answers 409 at once. 40001 would read as a
    -- serialization failure, which it retries until the gateway gives up.
    raise exception 'Someone else changed this since it was opened.' using errcode = 'PT409';
  end if;
  return v_at;
end $$;

revoke all on function public.abo_admin_demo_follow_up(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.abo_admin_demo_follow_up(uuid, text, text, timestamptz) to authenticated;

-- ── The requests, with where each stands ────────────────────
-- 0115's body, with four columns after it.
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
  followed_up_by    text
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
      fu.email::text
    from public.landing_events e
    left join public.demo_followups f on f.event_id = e.id
    left join auth.users fu on fu.id = f.updated_by
    where e.event = 'demo_booked'
    order by e.created_at desc;
end $$;

revoke all on function public.abo_admin_demo_requests() from public, anon;
grant execute on function public.abo_admin_demo_requests() to authenticated;

-- ── One account, all of it ──────────────────────────────────
-- ponytail: the trail is the latest 50. Page it when an account has more.
create or replace function public.abo_admin_account(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_email text;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select lower(email) into v_email from auth.users where id = p_user;
  if v_email is null then
    raise exception 'No such account.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'projects', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', p.name,
               'created_at', p.created_at,
               'members', (select count(*) from public.project_members m
                            where m.project_id = p.id and m.user_id is not null),
               'stores', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'domain', s.shop_domain,
                                   'status', s.status,
                                   'connected_at', s.connected_at,
                                   'last_synced_at', s.last_synced_at,
                                   'problem', s.webhook_error)
                                 order by s.created_at), '[]'::jsonb)
                            from public.stores s where s.project_id = p.id))
             order by p.created_at desc), '[]'::jsonb)
        from public.projects p where p.owner_id = p_user),
    'invite', (
      select jsonb_build_object(
               'by', cu.email::text, 'note', i.note,
               'made_at', i.created_at, 'claimed_at', c.claimed_at)
        from public.account_invite_claims c
        join public.account_invites i on i.id = c.invite_id
        left join auth.users cu on cu.id = i.created_by
       where c.user_id = p_user
       order by c.claimed_at
       limit 1),
    'demos', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'at', e.created_at,
               'store', e.payload->>'store',
               'note', nullif(e.payload->>'note', ''),
               'stage', coalesce(f.stage, 'new'))
             order by e.created_at desc), '[]'::jsonb)
        from public.landing_events e
        left join public.demo_followups f on f.event_id = e.id
       where e.event = 'demo_booked'
         and lower(btrim(e.payload->>'email')) = v_email),
    'trail', (
      select coalesce(jsonb_agg(t order by t.at desc), '[]'::jsonb)
        from (select a.action, a.old_value, a.new_value, a.created_at as at, au.email::text as by
                from public.admin_account_audit a
                left join auth.users au on au.id = a.actor_user_id
               where a.target_user_id = p_user
               order by a.created_at desc
               limit 50) t)
  );
end $$;

revoke all on function public.abo_admin_account(uuid) from public, anon;
grant execute on function public.abo_admin_account(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
