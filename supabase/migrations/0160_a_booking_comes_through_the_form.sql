-- Migration 0160: a booking comes through the form, or not at all
--
-- The early-access form checks a CAPTCHA on the server before it books
-- (src/app/actions.ts), but since 0066 the public key could write any
-- landing event, a booking included, straight into the table: a script
-- skipped the form, the CAPTCHA with it, and filled the admin's Early
-- access list. The cap per session (0116) did not stop it, because the
-- session is whatever the caller says it is.
--
-- So a booking is written only by abo_book_demo, which takes the
-- server's booking key (BOOKING_KEY; its sha256 in app_secrets, set
-- with scripts/set-server-key.mjs --for booking). The public key still
-- writes what a visitor does on the page, which is all it was for.
-- Nothing else changes: the same columns, the same cap, the same
-- unique index on (session_id, idem) that keeps a resent booking single.
--
-- Callers: src/app/actions.ts, scripts/check-landing-cap.mjs.

create or replace function public.abo_book_demo(p_key text, p_booking jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(length(p_key), 0) < 32 or not exists (
       select 1 from public.app_secrets
        where name = 'booking_key_sha256'
          and value = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'Not from the form.' using errcode = '42501';
  end if;
  insert into public.landing_events (session_id, variant, utm_source, utm_medium, utm_campaign, utm_content,
                                     utm_term, landing_path, event, idem, payload)
  values (p_booking ->> 'session_id', p_booking ->> 'variant', p_booking ->> 'utm_source',
          p_booking ->> 'utm_medium', p_booking ->> 'utm_campaign', p_booking ->> 'utm_content',
          p_booking ->> 'utm_term', p_booking ->> 'landing_path', 'demo_booked', p_booking ->> 'idem',
          coalesce(p_booking -> 'payload', '{}'::jsonb));
end $$;
revoke all on function public.abo_book_demo(text, jsonb) from public;
grant execute on function public.abo_book_demo(text, jsonb) to anon, authenticated;

drop policy if exists landing_events_anyone_may_write on public.landing_events;
create policy landing_events_anyone_may_write
  on public.landing_events for insert
  to anon, authenticated
  with check (event <> 'demo_booked');

NOTIFY pgrst, 'reload schema';
