-- Migration 0075: the difference between picking India and never
-- being asked.
--
-- A project's currency defaults to INR, so a merchant who has never
-- opened the settings and a merchant who deliberately chose rupees
-- store the same value. Imported Shopify amounts are shown in the
-- shop's own currency; the rough project-currency line underneath is
-- only wanted by the second merchant. Told apart by the value alone,
-- everyone got it — including every shop that has nothing to do with
-- India and simply inherited the default.
--
-- One boolean, set by the route that serves the settings form. It is
-- false for every row that exists today, which is correct: nobody
-- currently in this table has been asked.
--
-- Deliberately NOT done here: making the project currency follow the
-- connected store. That sounds tidier and is worse — the settings
-- dropdown pairs a currency with a locale, so adopting USD would also
-- move an Indian merchant's dates and digit grouping to American ones
-- because of where their customers happen to pay from.
--
-- Callers: src/app/api/projects/route.ts, src/components/AppShell.tsx.

alter table public.projects
  add column if not exists currency_set_by_user boolean not null default false;

comment on column public.projects.currency_set_by_user is
  'True once the owner has chosen a currency in project settings. Until then the stored currency is only a default, and imported amounts are shown in the shop''s own currency with nothing beside them.';

NOTIFY pgrst, 'reload schema';
