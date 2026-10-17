-- Migration 0230: what Luke found looking into an alert is kept with it (17 Oct, the sprint's Days 12–13)
--
-- "Close the browser, change a test store's data, and reopen it: Luke has
-- investigated and recorded the issue." RTO rising was looked into only
-- when the app was open (abo_rto_cohorts by payment and by state, read in
-- the browser), so nothing was recorded and neither Luke's turn nor their
-- own AI saw it. The watch now records it as it notices: the same cohorts,
-- over every shipment of the alert's own window, kept in the alert's facts
-- (by_payment, by_state), moving with them on each run without ringing
-- again. The other kinds already keep their evidence in their facts.
--
-- A wrapper, so the check itself (0221) is unchanged.

create or replace function public.abo_alert_rto_found(p_store uuid, p_set jsonb)
returns table (subject text, severity text, facts jsonb)
language sql stable security definer set search_path = public as $$
  select a.subject, a.severity,
         a.facts || jsonb_build_object(
           'by_payment', jsonb_build_object(
             'groups', public.abo_rto_cohorts(p_store, (a.facts->>'days')::int, 'payment', 20)->'groups'),
           'by_state', jsonb_build_object(
             'groups', public.abo_rto_cohorts(p_store, (a.facts->>'days')::int, 'state', 20)->'groups'))
    from public.abo_alert_rto_rising(p_store, p_set) a
$$;
revoke all on function public.abo_alert_rto_found(uuid, jsonb) from public, anon, authenticated;

update public.alert_kinds set check_fn = 'abo_alert_rto_found' where kind = 'rto_rising';

notify pgrst, 'reload schema';
