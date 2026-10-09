-- Migration 0200: Luke meets them first
--
-- After onboarding, a new owner's app opens on a conversation with Luke,
-- full screen, before anything else: he speaks first, from their own
-- store, and asks what takes their day until he has helped (9 Oct). The
-- store opens once he has.
--
-- - profiles.met_luke_at: when they were let into the store. Null means
--   the conversation is still the first thing they see. Set once, to now,
--   like onboarded_at: a browser cannot backdate it or take it back; the
--   server (service role) alone may clear it, to show it again.
--   Everybody already onboarded has met him, so nobody already here is
--   sent back to a conversation they never needed.
-- - That conversation costs them nothing: its turns are counted apart, in
--   account_settings.meet_turns, not against the included free_turns, up
--   to twenty an account, ever. Past that, or once they have met him, a
--   turn is charged as any other. A design built in it is charged as any
--   other too: it is the build, not the talking.
-- - A refund puts back whichever count the spend took from.

-- ── When they were let in ──────────────────────────────────────
alter table public.profiles add column if not exists met_luke_at timestamptz;

update public.profiles
   set met_luke_at = coalesce(onboarded_at, now())
 where met_luke_at is null
   and onboarded_at is not null;

-- 0112's touch, with met_luke_at kept the way onboarded_at is.
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
  if tg_op = 'UPDATE' and old.met_luke_at is not null and coalesce(auth.role(), '') <> 'service_role' then
    new.met_luke_at := old.met_luke_at;
  elsif new.met_luke_at is not null then
    new.met_luke_at := now();
  end if;
  return new;
end $$;

-- ── The first conversation's turns, counted apart ─────────────
alter table public.account_settings
  add column if not exists meet_turns integer not null default 0,
  add column if not exists last_spend_meet boolean not null default false;

-- 0146's spend, with p_meeting: free for the owner, in their first
-- conversation, up to twenty turns an account.
drop function if exists public.abo_spend_turn(uuid);
create or replace function public.abo_spend_turn(p_project uuid default null, p_meeting boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_used integer;
  v_free integer;
  v_unlimited boolean;
  v_id uuid := gen_random_uuid();
  v_payer uuid := auth.uid();
  v_meet_max constant integer := 20;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_project is not null and not public.abo_owns(p_project) then
    if not public.abo_can_build(p_project) then
      raise exception 'Only the people the owner lets build can ask Luke here.' using errcode = '42501';
    end if;
    select owner_id into v_payer from public.projects where id = p_project;
  end if;

  insert into public.account_settings (user_id)
  values (v_payer)
  on conflict (user_id) do nothing;

  -- The first conversation: theirs (the owner's own app), not yet let
  -- into the store, and under the cap. Anything else falls through and
  -- is charged as usual.
  if p_meeting and p_project is not null and public.abo_owns(p_project)
     and exists (select 1 from public.profiles where user_id = auth.uid() and met_luke_at is null) then
    update public.account_settings
       set meet_turns      = meet_turns + 1,
           last_spend_at   = now(),
           last_spend_id   = v_id,
           last_spend_meet = true,
           last_refund_at  = null,
           updated_at      = now()
     where user_id = v_payer
       and meet_turns < v_meet_max
    returning turns_used, free_turns, turns_unlimited
         into v_used, v_free, v_unlimited;
    if v_used is not null then
      return jsonb_build_object(
        'ok', true, 'used', v_used, 'free', v_free,
        'unlimited', v_unlimited, 'spend_id', v_id, 'meeting', true
      );
    end if;
  end if;

  update public.account_settings
     set turns_used      = turns_used + 1,
         last_spend_at   = now(),
         last_spend_id   = v_id,
         last_spend_meet = false,
         last_refund_at  = null,
         updated_at      = now()
   where user_id = v_payer
     and (turns_unlimited or turns_used < free_turns)
  returning turns_used, free_turns, turns_unlimited
       into v_used, v_free, v_unlimited;

  if v_used is null then
    select turns_used, free_turns, turns_unlimited
      into v_used, v_free, v_unlimited
      from public.account_settings
     where user_id = v_payer;
    return jsonb_build_object(
      'ok', false, 'used', v_used, 'free', v_free,
      'unlimited', v_unlimited
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'used', v_used, 'free', v_free,
    'unlimited', v_unlimited, 'spend_id', v_id
  );
end $$;
revoke all on function public.abo_spend_turn(uuid, boolean) from public, anon;
grant execute on function public.abo_spend_turn(uuid, boolean) to authenticated;

-- 0146's refund, putting back whichever count the spend took from.
create or replace function public.abo_refund_turn(p_spend uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_spend is null then
    return jsonb_build_object('refunded', false);
  end if;

  update public.account_settings a
     set turns_used     = case when last_spend_meet then turns_used else greatest(turns_used - 1, 0) end,
         meet_turns     = case when last_spend_meet then greatest(meet_turns - 1, 0) else meet_turns end,
         last_refund_at = now(),
         updated_at     = now()
   where (a.user_id = auth.uid()
          or exists (select 1 from public.project_members pm
                       join public.projects p on p.id = pm.project_id
                      where pm.user_id = auth.uid() and pm.can_build and p.owner_id = a.user_id))
     and (case when last_spend_meet then meet_turns else turns_used end) > 0
     and last_spend_id = p_spend
     -- One refund per spend…
     and last_refund_at is null
     -- …and only for a spend that just happened. A turn takes seconds;
     -- anything older is somebody trying their luck.
     and last_spend_at > now() - interval '5 minutes'
  returning turns_used into v_used;

  return jsonb_build_object('refunded', v_used is not null, 'used', v_used);
end $$;

NOTIFY pgrst, 'reload schema';
