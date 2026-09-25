-- A row that comes back is the same row.
--
-- 0123 removes a row two finished checks in a row did not see, and says
-- one taken by mistake comes back with the next check that brings it.
-- It came back as a new row, under a new id: anything that pointed at
-- the old one, now or in a feature not yet written, would have lost it.
-- The Shopify-side links are rewritten by every pass, but nothing else
-- is, so the promise was only half kept.
--
-- So what is removed is written down first: the table, Shopify's id for
-- the row, and the id it had here. A row inserted again with the same
-- Shopify id takes its old id back, whoever inserts it (a pass, a
-- webhook, anything later), and the note is gone. One trigger on the
-- same seven tables; nothing that reads them changes. Notes older than
-- ninety days are dropped: a mistake is found by the next check, and a
-- row not back in three months was deleted.

create table if not exists public.store_row_tombstones (
  store_id    uuid not null references public.stores(id) on delete cascade,
  table_name  text not null,
  external_id text not null,
  row_id      uuid not null,
  removed_at  timestamptz not null default now(),
  primary key (store_id, table_name, external_id)
);

-- Read and written only by the functions below, never by a client.
alter table public.store_row_tombstones enable row level security;
revoke all on public.store_row_tombstones from anon, authenticated;

-- ── The same id, back ─────────────────────────────────────────────
-- A definer: whoever inserts (the owner, the worker's ticket, a webhook
-- function) cannot see the notes, and must not need to. Fires on insert
-- only; an upsert of a row still here finds no note and changes nothing.
create or replace function public.abo_keep_identity()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  delete from public.store_row_tombstones
   where store_id = new.store_id and table_name = tg_table_name and external_id = new.external_id
  returning row_id into v_id;
  if v_id is not null then
    new.id := v_id;
  end if;
  return new;
end $$;

revoke all on function public.abo_keep_identity() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['products', 'collections', 'customers', 'draft_orders', 'discounts', 'orders', 'locations'] loop
    execute format('drop trigger if exists abo_keep_identity on public.%I', t);
    execute format(
      'create trigger abo_keep_identity before insert on public.%I for each row execute function public.abo_keep_identity()',
      t
    );
  end loop;
end $$;

-- ── Removed, with a note ──────────────────────────────────────────
-- As 0123, but every row taken is written down as it goes, in the same
-- statement, and old notes are dropped.
create or replace function public.abo_store_forget_unseen(p_store uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_all_orders boolean;
  r            record;
  v_table      text;
  v_n          integer;
  v_out        jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select 'read_all_orders' = any(coalesce(s.granted_scopes, '{}'))
    into v_all_orders
    from public.stores s
   where s.id = p_store and public.abo_owns(s.project_id);
  if not found then
    raise exception 'not a store of yours';
  end if;

  delete from public.store_row_tombstones where store_id = p_store and removed_at < now() - interval '90 days';

  for r in
    select resource, prev_started_at, finished_at from public.import_runs
     where store_id = p_store and status = 'done' and prev_started_at is not null and finished_at is not null
  loop
    v_table := case r.resource
      when 'products' then 'products'
      when 'collections' then 'collections'
      when 'customers' then 'customers'
      when 'drafts' then 'draft_orders'
      when 'discounts' then 'discounts'
      when 'orders' then 'orders'
      when 'locations' then 'locations'
    end;
    continue when v_table is null;
    execute format(
      'with gone as (
         delete from public.%I
          where store_id = $1 and created_at <= $2 and (seen_at is null or seen_at < $2)'
        || case when v_table = 'orders' and not v_all_orders then ' and placed_at >= $3' else '' end
        || ' returning id, external_id
       )
       insert into public.store_row_tombstones (store_id, table_name, external_id, row_id)
       select $1, %L, external_id, id from gone
       on conflict (store_id, table_name, external_id)
         do update set row_id = excluded.row_id, removed_at = now()',
      v_table, v_table
    ) using p_store, r.prev_started_at, r.finished_at - interval '59 days';
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_out := v_out || jsonb_build_object(r.resource, v_n);
    end if;
  end loop;
  return v_out;
end $$;

revoke all on function public.abo_store_forget_unseen(uuid) from public, anon;
grant execute on function public.abo_store_forget_unseen(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
