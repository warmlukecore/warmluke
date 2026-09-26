-- Your fields on the store's rows.
--
-- A section over the store's orders showed Shopify's columns and
-- nothing of the merchant's: a field to type into could not be kept
-- on a store row, because the next import rewrites that row. So a
-- design for packing orders built a second list of orders to fill in
-- by hand, beside the real ones, and the two never matched.
--
-- What the merchant fills in beside a store row is a record of the
-- section, pointing at the row: records.store_row_id, the row's own id,
-- which a row keeps through every import (and through a removal and a
-- return, 0124). The import never touches records, so nothing it does
-- can overwrite them; the section reads the store's rows and lays each
-- row's record over it. Records are what rules already run on, so a
-- rule on one of these fields runs as on any other.
--
--   one record per row per section: a unique index, not a convention
--   a store section's records always name a row, and an own section's
--   never do: checked as the row is written, so no writer, the chat,
--   a rule or a future one, can put a row of its own into a store list

alter table public.records add column if not exists store_row_id uuid;

create unique index if not exists records_one_per_store_row
  on public.records (module_id, store_row_id)
  where store_row_id is not null;

create or replace function public.abo_record_store_row_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source  text;
  v_project uuid;
  v_view    text;
  v_here    boolean;
begin
  select m.source_table, m.project_id into v_source, v_project from public.modules m where m.id = new.module_id;
  if v_source is not null and new.store_row_id is null then
    raise exception 'A row of a section over the store is the store''s: fields go beside one of its rows.'
      using errcode = '23514';
  end if;
  if v_source is null and new.store_row_id is not null then
    raise exception 'Only a section over the store has rows of the store''s.' using errcode = '23514';
  end if;
  -- One of this project's own store's rows, whoever writes: the route
  -- checks it too, but a direct write under the owner's rights does not
  -- pass through the route. A list whose rows have no id of their own
  -- has none to name.
  if v_source is not null then
    v_view := public.abo_store_view(v_source);
    begin
      if v_view is null then raise undefined_table; end if;
      execute format(
        'select exists (select 1 from public.%I v
                          join public.stores s on s.id = v.store_id
                         where v.id = $1 and s.project_id = $2)', v_view)
        into v_here using new.store_row_id, v_project;
    exception when undefined_column or undefined_table or syntax_error then
      v_here := false;
    end;
    if not coalesce(v_here, false) then
      raise exception 'That row is not one of this project''s store''s.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- A trigger's helper: not a door for anyone to call.
revoke execute on function public.abo_record_store_row_guard() from public, anon, authenticated;

drop trigger if exists records_store_row_guard on public.records;
create trigger records_store_row_guard
  before insert or update of module_id, store_row_id on public.records
  for each row execute function public.abo_record_store_row_guard();

-- A stat over a store section counts what the section shows: the
-- store's rows with the merchant's fields beside them ("packed today"
-- read nothing when the stat saw the store's rows alone). And a stat
-- over a section of its own counts only its own rows, never fields
-- left beside a store row by a section since pointed back at its own.
-- abo_section_stats as 0089 wrote it, but for those two reads.
create or replace function public.abo_section_stats(
  p_module uuid,
  p_stats  jsonb,
  p_scope  jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_source   text;
  v_store    uuid;
  v_view     text;
  v_ctx      jsonb;
  v_search   text;
  v_fields   jsonb;
  v_cur      jsonb;
  v_out      jsonb := '[]'::jsonb;
  c          jsonb;
  f          record;
  st         jsonb;
  i          int;
  n          int;
  v_op       text;
  v_val      jsonb;
  v_whr      jsonb;
  v_by       text;
  v_lim      int;
  one        jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select m.project_id, m.source_table into v_project, v_source
    from public.modules m where m.id = p_module;
  if v_project is null or not public.abo_can_use(v_project) then
    raise exception 'No such section on this account.' using errcode = '42501';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'array' then
    raise exception 'Stats must be a list.' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_stats);
  if n > 12 then
    raise exception 'Too many stats.' using errcode = '22023';
  end if;
  if n = 0 then return v_out; end if;

  create temp table if not exists abo_stat_rows (rec jsonb) on commit drop;
  truncate abo_stat_rows;

  if v_source is null then
    insert into abo_stat_rows select r.data from public.records r where r.module_id = p_module and r.store_row_id is null;
  elsif public.abo_is_store_table(v_source) then
    select s.id into v_store
      from public.stores s
     where s.project_id = v_project and s.status = 'connected'
     limit 1;
    if v_store is not null then
      v_view := public.abo_store_view(v_source);
      -- Each row with the merchant's own fields under it: the store's
      -- value wins a name the two share, as withOwnFields does. Matched
      -- as text, because a list that groups rows has no id to match.
      execute format(
        'insert into abo_stat_rows
           select coalesce(r.data, ''{}''::jsonb) || to_jsonb(v)
             from public.%I v
             left join public.records r
               on r.module_id = $2 and r.store_row_id::text = to_jsonb(v)->>''id''
            where v.store_id = $1', v_view)
        using v_store, p_module;
    end if;
  end if;

  v_ctx := jsonb_build_object('module_id', p_module);

  -- Computed columns, in the order declared: each may read the ones
  -- above it, as withComputed does in the browser.
  for c in select value from jsonb_array_elements(coalesce(p_scope->'computed', '[]'::jsonb)) loop
    -- "where true": the API role refuses an update with no where at all.
    update abo_stat_rows
       set rec = rec || jsonb_build_object(c->>'field', public.abo_eval(c->'expr', rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
     where true;
  end loop;

  -- What the person is looking at: the search box, then each filter.
  v_search := nullif(btrim(coalesce(p_scope->>'search', '')), '');
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_fields := coalesce(p_scope->'search_fields', '[]'::jsonb);
    if jsonb_typeof(v_fields) = 'array' and jsonb_array_length(v_fields) > 0 then
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_array_elements_text(v_fields) fld
          where coalesce(t.rec->>fld, '') ilike v_search);
    else
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_each_text(t.rec) e where e.value ilike v_search);
    end if;
  end if;
  for f in select key, value from jsonb_each_text(coalesce(p_scope->'filters', '{}'::jsonb)) where btrim(value) <> '' loop
    delete from abo_stat_rows t where not public.abo_stat_matches(t.rec -> f.key, f.value);
  end loop;

  v_cur := coalesce(p_scope->'currency_fields', '[]'::jsonb);
  if jsonb_typeof(v_cur) <> 'array' then v_cur := '[]'::jsonb; end if;

  for i in 0 .. n - 1 loop
    st    := p_stats->i;
    v_op  := coalesce(st->>'op', 'count');
    v_val := coalesce(st->'value', case when st->>'field' is not null then jsonb_build_object('field', st->>'field') else null end);
    v_whr := st->'where';
    v_by  := nullif(btrim(coalesce(st->>'by', '')), '');
    v_lim := least(greatest(coalesce((st->>'limit')::int, 5), 1), 20);

    if v_by is null then
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      )
      select jsonb_build_object(
               'count', count(*),
               'value', case v_op
                          when 'count' then count(*)::numeric
                          when 'sum'   then coalesce(sum(v), 0)
                          when 'avg'   then avg(v)
                          when 'min'   then min(v)
                          when 'max'   then max(v)
                        end,
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''))
        into one
        from m;
    else
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      ),
      g as (
        select coalesce(rec->>v_by, '') as k,
               count(*) as c,
               case v_op
                 when 'count' then count(*)::numeric
                 when 'sum'   then coalesce(sum(v), 0)
                 when 'avg'   then avg(v)
                 when 'min'   then min(v)
                 when 'max'   then max(v)
               end as agg
          from m
         group by 1
      )
      select jsonb_build_object(
               'count', (select count(*) from m),
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''),
               'groups', coalesce((select jsonb_agg(jsonb_build_object('key', t.k, 'value', t.agg, 'count', t.c)
                                                    order by t.agg desc nulls last, t.c desc, t.k)
                                     from (select * from g order by agg desc nulls last, c desc, k limit v_lim) t),
                                  '[]'::jsonb))
        into one;
    end if;
    v_out := v_out || jsonb_build_array(one);
  end loop;

  return v_out;
end $$;

-- A rule on a store section runs when a field of the merchant's
-- changes. The first one kept on a row inserts its record, which read
-- as "a row was created": a rule "when packed" missed the first tick,
-- and one "when a row is added" fired on an order nobody added here.
-- run_record_automations as 0015 wrote it, but for those two tests.
create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  rec_data jsonb := coalesce(new.data, '{}'::jsonb) || jsonb_build_object('id', new.id);
  old_data jsonb := case when TG_OP = 'UPDATE'
                         then coalesce(old.data, '{}'::jsonb) || jsonb_build_object('id', new.id)
                         else '{}'::jsonb end;
  ctx jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  for auto in
    select * from public.automations a
    where a.enabled and a.module_id = new.module_id
  loop
    begin
      if (auto.definition->'trigger'->>'type') = 'record_created' then
        -- Fields kept beside a store row are not a row somebody made.
        if TG_OP <> 'INSERT' or new.store_row_id is not null then continue; end if;
      elsif (auto.definition->'trigger'->>'type') = 'record_updated' then
        -- Beside a store row, the first field kept is a change to a row
        -- that was already there: "when packed" fires on the first tick.
        if TG_OP <> 'UPDATE' and new.store_row_id is null then continue; end if;
      else
        continue;
      end if;

      if auto.definition->'trigger' ? 'when' then
        if not public.abo_bool(
             public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb, ctx)
           ) then
          continue;
        end if;
      end if;

      perform public.abo_run_actions(
        auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
        new.id, new.project_id, rec_data, old_data, ctx
      );

    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, new.id, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return new;
end;
$$ language plpgsql security definer;

NOTIFY pgrst, 'reload schema';
