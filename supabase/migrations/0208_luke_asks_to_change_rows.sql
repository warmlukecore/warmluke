-- Migration 0208: Luke asks to change rows
--
-- Eyes and hands (12 Oct, docs/ai-builder/parity.md). A merchant changes
-- the values in their rows by hand: a cell, a row's pop-up, ticked rows,
-- a row's button. Luke and their own AI could only read those rows; asked
-- to change one, Luke said "open the row and edit it yourself".
--
-- Now either may ask, and the owner says yes. The ask waits in 0183's
-- row_approvals, the owner's bell, beside a teammate's press:
--
-- - kind        'button' (a row's button, pressed: worked out again from
--               the row as it is when approved) or 'change' (fields set
--               to values, applied only where the row still holds what
--               the asker saw, kept in `before`).
-- - batch       one ask over many rows is one card and one yes.
-- - asked_via   'app' (a teammate), 'luke', or 'mcp' (their own AI): the
--               database says which, never the caller.
-- - summary     the card's sentence, written by the server from the change.
--
-- Only the owner decides (abo_decide_approval, unchanged), never an AI's
-- token. Asking takes no more rights than reading the project: a change
-- is made later, under the owner's own rights, through the one write door.

alter table public.row_approvals add column if not exists kind text not null default 'button';
alter table public.row_approvals add column if not exists batch uuid;
alter table public.row_approvals add column if not exists asked_via text not null default 'app';
alter table public.row_approvals add column if not exists before jsonb;
alter table public.row_approvals add column if not exists summary text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'row_approvals_kind_check') then
    alter table public.row_approvals add constraint row_approvals_kind_check check (kind in ('button', 'change'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'row_approvals_via_check') then
    alter table public.row_approvals add constraint row_approvals_via_check check (asked_via in ('app', 'luke', 'mcp'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'row_approvals_summary_check') then
    alter table public.row_approvals add constraint row_approvals_summary_check
      check (summary is null or char_length(summary) <= 300);
  end if;
end $$;
create index if not exists row_approvals_batch on public.row_approvals (batch) where batch is not null;

/**
 * An ask to change rows of one section, waiting for the owner's yes. Each
 * row: { record_id | store_row_id, set, before?, row_label? }; for a
 * button, p_action names it and set is what it would do now. At most 500
 * rows. Returns the batch and how many are waiting (a row already waiting
 * for the same button is that one, not a second).
 */
create or replace function public.abo_ask_rows(
  p_project uuid, p_module uuid, p_kind text, p_action text, p_rows jsonb, p_summary text
)
returns jsonb
language plpgsql volatile security definer set search_path = public, auth as $$
declare
  v_batch  uuid := gen_random_uuid();
  v_via    text := case when public.abo_is_oauth_client() then 'mcp' else 'luke' end;
  v_action text;
  v_n      integer := 0;
  v_one    integer;
  r        jsonb;
  v_rec    uuid;
  v_store  uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_can_use(p_project)
     or not exists (select 1 from public.modules m where m.id = p_module and m.project_id = p_project) then
    raise exception 'Not a section of yours.' using errcode = '42501';
  end if;
  if p_kind not in ('button', 'change') then
    raise exception 'A button or a change.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then
    raise exception 'Between 1 and 500 rows.' using errcode = '22023';
  end if;
  if p_summary is null or char_length(btrim(p_summary)) = 0 then
    raise exception 'Say what changes.' using errcode = '22023';
  end if;
  -- A change waits under its batch, so two asks never fold into one; a
  -- button under its own name, so it is the same wait as a teammate's press.
  v_action := case when p_kind = 'change' then 'change:' || v_batch else left(btrim(coalesce(p_action, '')), 80) end;
  if v_action = '' then
    raise exception 'Which button.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_rec := nullif(r->>'record_id', '')::uuid;
    v_store := nullif(r->>'store_row_id', '')::uuid;
    if (v_rec is null) = (v_store is null) then
      raise exception 'Each row is a record or a store row.' using errcode = '22023';
    end if;
    if jsonb_typeof(r->'set') <> 'object' or length((r->'set')::text) > 4000 then
      raise exception 'Each row says what it sets.' using errcode = '22023';
    end if;
    -- A record of this section, as the caller may read it; a store row is
    -- checked where it is written, against this project's own store.
    if v_rec is not null and not exists (
      select 1 from public.records x where x.id = v_rec and x.module_id = p_module
    ) then
      raise exception 'A row that is not in this section.' using errcode = '22023';
    end if;
    insert into public.row_approvals (
      project_id, module_id, record_id, store_row_id, action, row_label, set,
      kind, batch, asked_via, before, summary
    ) values (
      p_project, p_module, v_rec, v_store, v_action, left(coalesce(r->>'row_label', ''), 120), r->'set',
      p_kind, v_batch, v_via,
      case when jsonb_typeof(r->'before') = 'object' then r->'before' end,
      left(btrim(p_summary), 300)
    )
    on conflict (module_id, coalesce(record_id, store_row_id), action) where status = 'waiting' do nothing;
    get diagnostics v_one = row_count;
    v_n := v_n + v_one;
  end loop;
  return jsonb_build_object('batch', v_batch, 'asked', v_n,
    'already_waiting', jsonb_array_length(p_rows) - v_n, 'via', v_via);
end $$;
revoke all on function public.abo_ask_rows(uuid, uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.abo_ask_rows(uuid, uuid, text, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
