-- The code worker saves a row already there (0149's door, open to anon).
--
-- 0149 made every change to a row go through abo_record_patch and gave
-- it to signed-in users only. The code worker writes with its ticket as
-- anon (0134: records_code_ticket), so a rule with nobody watching could
-- add rows but never change one: "Set ship by date daily" failed every
-- day in production with "permission denied for function
-- abo_record_patch" (4 Oct). check-code-jobs-live only ever added rows.
--
-- The function runs as its caller: the row policies decide what it may
-- read and change, so anon with no ticket finds no row ("missing") and
-- changes nothing. 0142 opened 0140's gates to anon the same way.
--
-- Callers: src/lib/record-write.ts, from the code worker (src/lib/code-rules.ts).

grant execute on function public.abo_record_patch(uuid, jsonb, jsonb) to anon;

NOTIFY pgrst, 'reload schema';
