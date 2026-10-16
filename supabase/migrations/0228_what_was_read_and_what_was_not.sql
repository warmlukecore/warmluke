-- Migration 0228: what was read of their website, and what was not (16 Oct)
--
-- The sprint asks for coverage said out loud: which pages were read, which
-- were not there, which could not be read. Kept beside when the site was
-- read (0223), one word a page:
--
--   projects.site_coverage   { "home": "read", "refund": "read", "shipping": "not found",
--                              "about": "read", "faq": "not found" } ; "could not be read"
--                              when the site turned the read away or did not answer
--
-- Luke reads it so a page that was not found is never said as "they have no
-- returns policy", and Settings shows it beside what the site said.

alter table public.projects add column if not exists site_coverage jsonb;

notify pgrst, 'reload schema';
