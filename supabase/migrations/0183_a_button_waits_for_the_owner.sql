-- A button that waits for the owner (#6, 5 Oct).
--
-- A row's button can be marked "approval" (a refund, a discount, a
-- cancellation). The owner's press does its change at once; a teammate's
-- press is kept here, waiting, and shown in the owner's bell, and the
-- change is made when the owner says yes (app/api/row-action, through the
-- same door as every write, under the owner's own rights). A teammate
-- cannot make the same change by hand: lib/record-write.ts refuses it.
--
-- Only the owner decides, and only in Warmluke: the merchant's own AI can
-- read what waits (their RLS), never decide (nothing here takes its token).
-- One press waits a row and a button at a time.

create table if not exists public.row_approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  module_id uuid not null references public.modules(id) on delete cascade,
  record_id uuid references public.records(id) on delete cascade,
  store_row_id uuid,
  action text not null check (char_length(action) between 1 and 80),
  -- The row as the owner will know it in the bell ("#1042 · Asha").
  row_label text not null default '' check (char_length(row_label) <= 120),
  set jsonb not null default '{}'::jsonb,
  asked_by uuid not null default auth.uid(),
  asked_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'stale')),
  decided_by uuid,
  decided_at timestamptz,
  check (record_id is not null or store_row_id is not null)
);

create unique index if not exists row_approvals_one_waiting
  on public.row_approvals (module_id, coalesce(record_id, store_row_id), action)
  where status = 'waiting';
create index if not exists row_approvals_by_project on public.row_approvals (project_id, status, asked_at desc);

alter table public.row_approvals enable row level security;

-- Read by whoever can use the project: the owner's bell, the asker's own.
drop policy if exists row_approvals_read on public.row_approvals;
create policy row_approvals_read on public.row_approvals
  for select to authenticated using (public.abo_can_use(project_id));

-- Heard as it changes, so the owner's bell shows a press the moment it is made.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'row_approvals') then
    execute 'alter publication supabase_realtime add table public.row_approvals';
  end if;
end $$;

-- No write of the table itself: the functions below are the way in.
drop policy if exists row_approvals_oauth_no_insert on public.row_approvals;
create policy row_approvals_oauth_no_insert on public.row_approvals
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists row_approvals_oauth_no_update on public.row_approvals;
create policy row_approvals_oauth_no_update on public.row_approvals
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists row_approvals_oauth_no_delete on public.row_approvals;
create policy row_approvals_oauth_no_delete on public.row_approvals
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- A teammate's press: kept, waiting. The same press again is the same wait.
create or replace function public.abo_ask_approval(
  p_project uuid, p_module uuid, p_record uuid, p_store_row uuid, p_action text, p_set jsonb, p_row_label text
)
returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare
  v_id uuid;
begin
  if public.abo_is_oauth_client() then
    raise exception 'A button is pressed in Warmluke.' using errcode = '42501';
  end if;
  if not public.abo_can_use(p_project)
     or not exists (select 1 from public.modules m where m.id = p_module and m.project_id = p_project) then
    raise exception 'Not a section of yours.' using errcode = '42501';
  end if;
  insert into public.row_approvals (project_id, module_id, record_id, store_row_id, action, row_label, set)
  values (p_project, p_module, p_record, p_store_row, left(p_action, 80), left(coalesce(p_row_label, ''), 120),
          coalesce(p_set, '{}'::jsonb))
  on conflict (module_id, coalesce(record_id, store_row_id), action) where status = 'waiting' do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.row_approvals
     where module_id = p_module and coalesce(record_id, store_row_id) = coalesce(p_record, p_store_row)
       and action = left(p_action, 80) and status = 'waiting';
  end if;
  return v_id;
end $$;
revoke all on function public.abo_ask_approval(uuid, uuid, uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.abo_ask_approval(uuid, uuid, uuid, uuid, text, jsonb, text) to authenticated;

-- The owner's word: approved (the route then makes the change), declined,
-- or stale (the row no longer shows that button). Once, and the owner's alone.
create or replace function public.abo_decide_approval(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v jsonb;
begin
  if public.abo_is_oauth_client() then
    raise exception 'Only the owner decides, in Warmluke.' using errcode = '42501';
  end if;
  if p_status not in ('approved', 'declined', 'stale') then
    raise exception 'Approved, declined or stale.' using errcode = '22023';
  end if;
  update public.row_approvals a
     set status = p_status, decided_by = auth.uid(), decided_at = now()
   where a.id = p_id and a.status = 'waiting' and public.abo_owns(a.project_id)
  returning to_jsonb(a) into v;
  return v;
end $$;
revoke all on function public.abo_decide_approval(uuid, text) from public, anon;
grant execute on function public.abo_decide_approval(uuid, text) to authenticated;

NOTIFY pgrst, 'reload schema';
