-- Migration 0068: turning a shop's money into the merchant's money.
--
-- A store that sells in USD inside a project set to INR shows dollars,
-- because the number IS dollars and relabelling it would be a lie that
-- looks like a preference. The honest alternative is to convert it —
-- and a conversion is only honest if it says so, says at what rate,
-- and says which day that rate is from.
--
-- One rate per pair, kept here rather than fetched by every browser:
-- the same amount then reads the same on two screens, and one shop's
-- worth of merchants does not become one shop's worth of calls to
-- somebody else's API.
--
-- What this deliberately is NOT:
--
--   It is one CURRENT rate, not the rate on the day each order was
--   placed. An order from March converted at today's rate is "what
--   that would be worth now", which is a different question from "what
--   it was worth then" — so the app says which one it is answering
--   rather than letting the number imply the other.
--
--   ponytail: one rate per pair. Add a (base, quote, as_of) history
--   and convert each row by its own date when somebody needs the books
--   to balance rather than the dashboard to read.
--
-- Rates are public knowledge — no merchant's data is in here — so
-- reading is open to anyone signed in. Writing is not: a rate a client
-- could set is a number they could make any order worth anything.
--
-- Callers: src/app/api/fx/route.ts, src/components/AppShell.tsx.

create table if not exists public.fx_rates (
  base       text not null,
  quote      text not null,
  rate       numeric not null,
  -- The day the rate is from, as the source reported it.
  as_of      date not null,
  fetched_at timestamptz not null default now(),

  primary key (base, quote),
  constraint fx_rates_codes_look_like_codes
    check (base ~ '^[A-Z]{3}$' and quote ~ '^[A-Z]{3}$'),
  -- A zero or negative rate would make every amount wrong in a way
  -- that still renders.
  constraint fx_rates_rate_is_positive check (rate > 0)
);

comment on table public.fx_rates is
  'One current rate per currency pair. Public data, so readable by anyone signed in; written only through abo_fx_put.';

alter table public.fx_rates enable row level security;

drop policy if exists fx_rates_anyone_signed_in_may_read on public.fx_rates;
create policy fx_rates_anyone_signed_in_may_read
  on public.fx_rates for select
  to authenticated
  using (true);

revoke all on public.fx_rates from anon, authenticated;
grant select on public.fx_rates to authenticated;

-- Records a rate the server just fetched.
--
-- Security definer because nothing holding the public key may write
-- here: the rate decides what every imported amount is shown as.
create or replace function public.abo_fx_put(
  p_base  text,
  p_quote text,
  p_rate  numeric,
  p_as_of date
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_base !~ '^[A-Z]{3}$' or p_quote !~ '^[A-Z]{3}$' then
    raise exception 'Not a currency code.' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Not a rate.' using errcode = '22023';
  end if;

  insert into public.fx_rates (base, quote, rate, as_of, fetched_at)
  values (p_base, p_quote, p_rate, coalesce(p_as_of, current_date), now())
  on conflict (base, quote) do update
    set rate = excluded.rate,
        as_of = excluded.as_of,
        fetched_at = now();
end $$;

revoke all on function public.abo_fx_put(text, text, numeric, date) from public;
grant execute on function public.abo_fx_put(text, text, numeric, date) to authenticated;

NOTIFY pgrst, 'reload schema';
