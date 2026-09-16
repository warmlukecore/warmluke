-- Migration 0066: what the landing page learns.
--
-- The hero is going to be tested against several positioning angles,
-- and a test nobody measures is just a page that keeps changing. The
-- brief is blunt about it: without knowing which hero was shown, which
-- advertisement sent the person, whether they clicked, and whether
-- they actually booked, A/B testing is meaningless.
--
-- So one table, and one row per thing that happened. Not a funnel
-- table with a column per step: a step added later would need a
-- migration, and the questions being asked are not fixed yet.
--
-- Nobody signs in before any of this, so the insert is open to anon —
-- which makes it the one table on this database a stranger can write
-- to. Three things bound that:
--
--   the columns are short, and the payload is capped;
--   only the four events the page actually sends are allowed;
--   and one session may write sixty rows an hour, which is far more
--   than a person browsing produces and far less than a script wants.
--
-- Reading is not granted at all. These rows say which advertisement a
-- visitor came from and what they typed into a demo form; they are for
-- us, through the service role, and for nobody with the public key.
--
-- ponytail: the per-session cap is the whole rate limit. A determined
-- writer can rotate session ids; move to per-IP at the edge if that
-- ever actually happens.
--
-- Callers: src/app/page.tsx, src/lib/landing.ts.

create table if not exists public.landing_events (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null,
  variant      text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,
  utm_term     text,
  landing_path text,
  event        text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),

  constraint landing_events_known_event
    check (event in ('view', 'cta_click', 'demo_start', 'demo_booked')),
  constraint landing_events_session_is_sane
    check (length(session_id) between 8 and 64),
  constraint landing_events_short_fields
    check (
      coalesce(length(variant), 0) <= 64
      and coalesce(length(utm_source), 0) <= 200
      and coalesce(length(utm_medium), 0) <= 200
      and coalesce(length(utm_campaign), 0) <= 200
      and coalesce(length(utm_content), 0) <= 200
      and coalesce(length(utm_term), 0) <= 200
      and coalesce(length(landing_path), 0) <= 500
    ),
  constraint landing_events_payload_is_small
    check (length(payload::text) <= 4000)
);

comment on table public.landing_events is
  'One row per thing a visitor did on the landing page. Insert-only, and never readable with the public key.';

create index if not exists idx_landing_events_session
  on public.landing_events(session_id, created_at desc);
create index if not exists idx_landing_events_when
  on public.landing_events(created_at desc);

alter table public.landing_events enable row level security;

-- Written by people who have not signed in, which is the point.
drop policy if exists landing_events_anyone_may_write on public.landing_events;
create policy landing_events_anyone_may_write
  on public.landing_events for insert
  to anon, authenticated
  with check (true);

-- And read by nobody holding the public key. There is no select policy
-- on purpose: these rows name the advertisement a person came from.
revoke all on public.landing_events from anon, authenticated;
grant insert on public.landing_events to anon, authenticated;

create or replace function public.abo_landing_event_rate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_recent integer;
begin
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
