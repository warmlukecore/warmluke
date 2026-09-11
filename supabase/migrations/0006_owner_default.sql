-- Migration 0006: owner_id defaults to the authenticated user
alter table public.projects alter column owner_id set default auth.uid();

NOTIFY pgrst, 'reload schema';
