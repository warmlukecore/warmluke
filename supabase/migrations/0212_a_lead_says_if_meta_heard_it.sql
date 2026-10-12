-- Migration 0212: a lead says whether Meta heard it
--
-- Every early-access booking is now sent to Meta's Conversions API as a
-- Lead (the owner's call, 12 Oct: the measurement prompt governs only the
-- browser's Pixel and cookies; a browser sending Global Privacy Control
-- is still left out). Whether it went, or why not, was only in a server
-- log nobody reads, so the admin's Early access list could not be matched
-- against Ads Manager. The booking action now writes the outcome onto the
-- booking itself, as payload.meta { sent, why, test, at }.
--
-- Written with the server's booking key, as the booking is (0160), and
-- only onto that booking (session_id, idem: its unique index). What is
-- kept is rebuilt here from known fields, never stored as sent.
--
-- Callers: src/app/actions.ts.

create or replace function public.abo_book_demo_meta(p_key text, p_session text, p_idem text, p_meta jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(length(p_key), 0) < 32 or not exists (
       select 1 from public.app_secrets
        where name = 'booking_key_sha256'
          and value = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'Not from the form.' using errcode = '42501';
  end if;
  update public.landing_events
     set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
           'meta', jsonb_build_object(
             'sent', coalesce((p_meta ->> 'sent')::boolean, false),
             'why',  left(nullif(btrim(p_meta ->> 'why'), ''), 200),
             'test', coalesce((p_meta ->> 'test')::boolean, false),
             'at',   now()))
   where event = 'demo_booked'
     and session_id = p_session
     and idem = p_idem;
end $$;
revoke all on function public.abo_book_demo_meta(text, text, text, jsonb) from public;
grant execute on function public.abo_book_demo_meta(text, text, text, jsonb) to anon, authenticated;

-- 0141's list, one column longer: what became of each booking's Lead.
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
  invited_at        timestamptz,
  meta              jsonb
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
        where lower(i.email) = lower(btrim(e.payload->>'email'))),
      e.payload->'meta'
    from public.landing_events e
    left join public.demo_followups f on f.event_id = e.id
    left join auth.users fu on fu.id = f.updated_by
    where e.event = 'demo_booked'
    order by e.created_at desc;
end $$;
revoke all on function public.abo_admin_demo_requests() from public, anon;
grant execute on function public.abo_admin_demo_requests() to authenticated;

notify pgrst, 'reload schema';
