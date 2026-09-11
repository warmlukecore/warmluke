-- Migration 0011: money and dates belong to the owner's country.
-- The renderer formatted everything as en-US / USD, so an Indian shop
-- saw "$1,250.00" where it means ₹1,250. Locale is per project, not a
-- constant in the code; India is the default rather than the only option.

alter table public.projects
  add column if not exists locale text not null default 'en-IN',
  add column if not exists currency text not null default 'INR';

NOTIFY pgrst, 'reload schema';
