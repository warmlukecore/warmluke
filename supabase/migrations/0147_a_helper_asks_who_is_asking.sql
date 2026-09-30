-- The two helpers 0146 added for its policies answered anyone signed in:
-- which app a section belongs to, and whether a seat is on a section's
-- app, for any section or seat id at all. Every policy that calls them
-- also asks abo_may_change_module, so no row was ever let through; but a
-- door the public key can call must check its caller itself
-- (check-definer-grants), and these now answer only about an app the
-- caller is on.
--
-- Callers: the builder policies of 0146 (modules, automations,
-- module_shares, module_hides); scripts/check-definer-grants.mjs.

create or replace function public.abo_module_project(p_module uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.project_id from public.modules m
   where m.id = p_module and public.abo_can_use(m.project_id);
$$;

create or replace function public.abo_seat_of_module(p_member uuid, p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members pm
      join public.modules m on m.project_id = pm.project_id
     where pm.id = p_member and m.id = p_module
       and public.abo_can_use(m.project_id));
$$;

NOTIFY pgrst, 'reload schema';
