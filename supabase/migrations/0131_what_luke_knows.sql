-- What Luke knows about a business, learned from talking to its owner.
--
-- Every thread began from the onboarding line and the thread itself:
-- that the courier is Delhivery, that three people pack at five, that
-- COD is most of the orders — said once, then said again next week.
-- After a turn a small model writes down what the exchange told about
-- the business (facts, never a request), one line each, and the next
-- plan and answer read them. The owner sees the list and may strike a
-- line; nothing here is ever an instruction to the model.

create table if not exists public.merchant_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  note       text not null check (char_length(note) between 3 and 200),
  created_at timestamptz not null default now(),
  -- Said twice is known once.
  unique (project_id, note)
);
create index if not exists merchant_notes_project_newest on public.merchant_notes (project_id, created_at desc);

alter table public.merchant_notes enable row level security;

-- Whoever may use the project reads and strikes them; the writer is
-- the server on the owner's own client, so the same policy covers it.
drop policy if exists merchant_notes_member_all on public.merchant_notes;
create policy merchant_notes_member_all on public.merchant_notes
  for all to authenticated
  using (public.abo_can_use(project_id))
  with check (public.abo_can_use(project_id));

-- And the wall every table has, whatever else it has: no write from a
-- connected client's token (check-rls asks abo_tables_missing_oauth_guard).
drop policy if exists merchant_notes_oauth_no_insert on public.merchant_notes;
create policy merchant_notes_oauth_no_insert on public.merchant_notes
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists merchant_notes_oauth_no_update on public.merchant_notes;
create policy merchant_notes_oauth_no_update on public.merchant_notes
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists merchant_notes_oauth_no_delete on public.merchant_notes;
create policy merchant_notes_oauth_no_delete on public.merchant_notes
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- Forty lines a business: the oldest go as new ones come, so what is
-- read to the model stays a page, not a diary.
create or replace function public.merchant_notes_keep_newest()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.merchant_notes n
   where n.project_id = new.project_id
     and n.id in (
       select id from public.merchant_notes
        where project_id = new.project_id
        order by created_at desc, id desc
       offset 40
     );
  return null;
end $$;
revoke execute on function public.merchant_notes_keep_newest() from public, anon, authenticated;
drop trigger if exists merchant_notes_keep_newest on public.merchant_notes;
create trigger merchant_notes_keep_newest
  after insert on public.merchant_notes
  for each row execute function public.merchant_notes_keep_newest();

NOTIFY pgrst, 'reload schema';
