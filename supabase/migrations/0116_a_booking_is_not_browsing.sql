-- A booking is not browsing: the landing's cap stops counting one against the other.
--
-- 0067 capped a session at sixty landing_events an hour, of every kind
-- together. The landing now has a glimpse of the app to click through,
-- and every click in it is an event. A visitor curious enough to open
-- sixty things in it, then book a demo, was told the booking had not
-- sent: the one event the table is for, refused because of the ones it
-- is not.
--
-- So bookings are counted on their own. Browsing keeps its sixty an
-- hour, and can no longer use up a booking's room; bookings get five
-- an hour a session, far more than a person books and far fewer than a
-- script would want.
--
-- Everything else 0067 decided is kept: the database sets the clock,
-- and one session's inserts are counted one after another.
--
-- ponytail: still per session, as 0066 said. Per-IP at the edge if the
-- table is ever actually flooded.
--
-- Callers: every insert into landing_events (src/components/Landing.tsx,
-- src/app/actions.ts).

create or replace function public.abo_landing_event_rate()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_booking boolean := new.event = 'demo_booked';
  -- Named rather than written into the IF: PL/pgSQL ends an IF's
  -- condition at the first THEN, and a CASE has one of its own.
  v_cap     integer := case when new.event = 'demo_booked' then 5 else 60 end;
  v_recent  integer;
begin
  -- Whatever the caller sent, this is when it happened.
  new.created_at := clock_timestamp();

  perform pg_advisory_xact_lock(hashtext('landing:' || new.session_id));

  select count(*) into v_recent
    from public.landing_events
   where session_id = new.session_id
     and created_at > now() - interval '1 hour'
     and (event = 'demo_booked') = v_booking;

  if v_recent >= v_cap then
    raise exception 'Too many.' using errcode = '53400';
  end if;
  return new;
end $$;

NOTIFY pgrst, 'reload schema';
