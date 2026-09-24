-- Who asked for a demo, for the one screen allowed to read it.
--
-- A booking has been a landing_events row since 0066: event
-- 'demo_booked', what the person typed in its payload, and beside it
-- which hero they saw and which advertisement sent them. Nobody could
-- read those rows but the service role, on purpose, so the leads sat
-- in a table no screen showed.
--
-- They stay where they are. A second table would be a second copy of
-- the same booking, and the attribution is already on this row. What
-- is added is the reader: a security definer function that checks the
-- caller is an administrator first, the way abo_admin_accounts does,
-- so the rows are still closed to everybody holding the public key.
--
-- The payload is written by people who have not signed in, and not
-- only through the form: anyone with the public key can insert a row.
-- So every field comes back as text for the screen to show as text,
-- and nothing here trusts a value to be one of the form's lists.
--
-- ponytail: unpaged. Page it when bookings run into the thousands.
--
-- Callers: src/app/admin/demos/page.tsx.

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
  -- Whether the same address has since made an account, so a lead who
  -- signed up anyway is not chased as a stranger.
  has_account       boolean
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
      )
    from public.landing_events e
    where e.event = 'demo_booked'
    order by e.created_at desc;
end $$;

revoke all on function public.abo_admin_demo_requests() from public;
grant execute on function public.abo_admin_demo_requests() to authenticated;

NOTIFY pgrst, 'reload schema';
