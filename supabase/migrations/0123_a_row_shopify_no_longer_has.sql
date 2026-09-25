-- A row Shopify no longer has.
--
-- A delete webhook that never arrives leaves a row here for good, and
-- the import only upserts, so walking Shopify again never took it away.
-- The strip could only count the gap, rows held against rows a pass
-- brought back, and a count cannot say which rows or be acted on. It
-- put "Some rows are gone from Shopify" up with a Reconnect that could
-- not clear it, for as long as the store was connected.
--
-- So every write marks its row as seen. Whatever writes it (a pass, a
-- webhook, a change made through the app), Shopify has just said the
-- row exists. A trigger rather than each writer: the rows are written by
-- TypeScript savers and by SQL webhook functions, and a writer added
-- later is covered without knowing this exists.
--
-- A row a finished pass did not see is named on the strip. A row two
-- finished passes in a row did not see is removed, the way a delete
-- webhook removes it. One short bulk file must not cost a merchant their
-- rows; the same rows missing from two is a deletion. A row removed by
-- mistake comes back with the next pass that brings it.

-- ── Seen ──────────────────────────────────────────────────────────
create or replace function public.abo_mark_seen()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.seen_at := now();
  return new;
end $$;

-- Every row here now counts as seen now. Left empty, the first pass
-- after this would read every row it missed as missed twice, and one
-- pass is not enough to remove anything.
do $$
declare t text;
begin
  foreach t in array array['products', 'collections', 'customers', 'draft_orders', 'discounts', 'orders', 'locations'] loop
    execute format('alter table public.%I add column if not exists seen_at timestamptz', t);
    execute format('update public.%I set seen_at = now() where seen_at is null', t);
    execute format('create index if not exists %I on public.%I (store_id, seen_at)', 'idx_' || t || '_seen', t);
    execute format('drop trigger if exists abo_seen on public.%I', t);
    execute format(
      'create trigger abo_seen before insert or update on public.%I for each row execute function public.abo_mark_seen()',
      t
    );
  end loop;
end $$;

-- ── When a pass begins ────────────────────────────────────────────
-- Stamped by the database, so the pass and the rows it writes read one
-- clock. The pass that is ending becomes the one before, if it finished:
-- one that stopped half way saw only half the store.
alter table public.import_runs add column if not exists prev_started_at timestamptz;

create or replace function public.abo_pass_begins()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.started_at is distinct from old.started_at then
    new.prev_started_at := case when old.status = 'done' then old.started_at end;
    new.started_at := now();
  end if;
  return new;
end $$;

drop trigger if exists abo_pass_begins on public.import_runs;
create trigger abo_pass_begins before update of started_at on public.import_runs
  for each row execute function public.abo_pass_begins();

-- ── Removed ───────────────────────────────────────────────────────
-- Rows neither of the last two finished passes saw, and nothing has
-- written since the first of them began: gone from Shopify. Asked by the
-- store's owner as the strip reads the finished import; returns what it
-- removed, by resource. Orders outside the sixty days Shopify returns
-- without read_all_orders are never counted: no pass could bring them.
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
      'delete from public.%I where store_id = $1 and created_at <= $2 and (seen_at is null or seen_at < $2)'
        || case when v_table = 'orders' and not v_all_orders then ' and placed_at >= $3' else '' end,
      v_table
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
