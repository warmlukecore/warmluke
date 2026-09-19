-- Migration 0083: the wall reaches the judge.
--
-- 0028 refuses every write from a token carrying client_id, table by
-- table, and check-rls asks whether any public table is missing that
-- refusal. judgements (0082) was. It has no permissive write policy at
-- all, so nothing could write there anyway — but "nothing can" is a
-- property of today's policies, and the guard is what keeps it true
-- on the day somebody adds one.
--
-- Callers: none — policies only. Read by scripts/check-rls.mjs.

drop policy if exists "judgements_oauth_no_insert" on public.judgements;
create policy "judgements_oauth_no_insert"
  on public.judgements as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "judgements_oauth_no_update" on public.judgements;
create policy "judgements_oauth_no_update"
  on public.judgements as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "judgements_oauth_no_delete" on public.judgements;
create policy "judgements_oauth_no_delete"
  on public.judgements as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

NOTIFY pgrst, 'reload schema';
