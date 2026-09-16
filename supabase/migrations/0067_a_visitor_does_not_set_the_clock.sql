-- Migration 0067: the cap a visitor could set their own clock past.
--
-- 0066 let anyone insert into landing_events, which is right — nobody
-- has signed in when a landing page is read — and capped one session
-- at sixty rows an hour. Three things were wrong with that cap.
--
-- 1. The grant was on the whole table, so the caller could send
--    created_at as well. The trigger counted rows by created_at, so a
--    caller who backdated theirs was never inside the window and the
--    cap never applied at all. The clock belongs to the database.
--
-- 2. Two inserts arriving together each counted the rows the other had
--    not committed yet, and both passed. Rare with a person, ordinary
--    with a script — which is exactly who the cap is for.
--
-- 3. A booking that was written but whose answer never arrived would
--    be sent again, and the second one landed as a second lead. Nobody
--    loses data over it; somebody wastes a morning emailing the same
--    person twice.
--
-- What is deliberately NOT done: the cap is still per session id, and
-- a determined writer can mint new ones. Stopping that properly means
-- knowing the caller — a server route, per IP. This bounds accident
-- and casual noise, not somebody who has decided to flood it.
--
-- ponytail: per-session cap only. Move to per-IP at the edge if the
-- table is ever actually flooded.
--
-- Callers: src/components/Landing.tsx, src/app/actions.ts.

alter table public.landing_events
  add column if not exists idem text;

comment on column public.landing_events.idem is
  'Per-submission key, so a retried booking lands once.';

-- One booking per key. Only bookings: a session sends many views, and
-- they carry no key at all.
create unique index if not exists idx_landing_events_once
  on public.landing_events(session_id, idem)
  where event = 'demo_booked' and idem is not null;

-- The caller names what happened. It does not name when.
revoke insert on public.landing_events from anon, authenticated;
grant insert (
  session_id, variant,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  landing_path, event, payload, idem
) on public.landing_events to anon, authenticated;

create or replace function public.abo_landing_event_rate()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_recent integer;
begin
  -- Whatever the caller sent, this is when it happened.
  new.created_at := clock_timestamp();

  -- Held to the end of this transaction, so two inserts for one
  -- session are counted one after the other rather than both against
  -- a total neither of them is in yet.
  perform pg_advisory_xact_lock(hashtext('landing:' || new.session_id));

  select count(*) into v_recent
    from public.landing_events
   where session_id = new.session_id
     and created_at > now() - interval '1 hour';

  if v_recent >= 60 then
    raise exception 'Too many.' using errcode = '53400';
  end if;
  return new;
end $$;

drop trigger if exists trg_landing_events_rate on public.landing_events;
create trigger trg_landing_events_rate
  before insert on public.landing_events
  for each row execute function public.abo_landing_event_rate();

NOTIFY pgrst, 'reload schema';
