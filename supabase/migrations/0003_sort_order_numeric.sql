-- Migration 0003: fractional nav positions ("move between X and Y")
alter table public.modules alter column sort_order type double precision;

NOTIFY pgrst, 'reload schema';
