-- The code worker asks the same doors (0140's gates, open to anon).
--
-- 0140 put two new gates on the read policies of modules, records,
-- ui_schemas and stores (abo_can_see_module, abo_can_open_store) and
-- took anon's right to run them away. Postgres asks every permissive
-- policy of a table, so a caller who may not run one of them is refused
-- the whole read, not only that policy's rows. The code worker reads with
-- its ticket as anon (0134: modules_code_ticket and the rest), and every
-- read of a section it made failed with "permission denied for function
-- abo_can_see_module"; check-code-jobs-live caught it.
--
-- Both gates answer only for the caller: with no signed-in user they say
-- no, so anon running them opens nothing. abo_can_use, which they replaced
-- in those policies, was open to anon the same way.
--
-- Callers: the read policies 0140 wrote; the code worker (src/lib/code-rules.ts).

grant execute on function public.abo_can_see_module(uuid) to anon;
grant execute on function public.abo_can_open_store(uuid) to anon;

NOTIFY pgrst, 'reload schema';
