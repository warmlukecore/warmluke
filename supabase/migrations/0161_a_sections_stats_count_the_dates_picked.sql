-- Migration 0161: a section's stats count the dates picked above it
--
-- A section may carry a choice of dates (features.period): chips for
-- the last N days, the owner's own dates, or all. The rows the page
-- reads are narrowed to them, and so must the stat cards be, which are
-- counted here over the whole section, or the cards and the table would
-- tell two stories. The page sends what was picked in p_scope.period:
--
--   { "field": "placed_at", "from_day": "2026-09-19", "to_day": "2026-10-03",
--     "from": "2026-09-18T18:30:00Z", "to": "2026-10-03T18:30:00Z" }
--
-- the days as the shop's zone has them, and the instants those days
-- start and stop at. A bare day (a date column of the owner's) is
-- compared as a day; a timestamp (a store's placed_at) by its instant,
-- so an order at half past midnight in Mumbai is that day's. Empty, or
-- not a date at all, is outside. lib/period.ts holds the same rule for
-- the browser (inPeriod), and scripts/check-period.mjs both together.
--
-- abo_section_stats is 0140's, with the one step added after the filters.

create or replace function public.abo_in_period(p_value text, p_period jsonb) returns boolean
language plpgsql stable set search_path = public as $$
declare
  v timestamptz;
begin
  if p_value is null or btrim(p_value) = '' then
    return false;
  end if;
  if btrim(p_value) ~ '^\d{4}-\d{2}-\d{2}$' then
    return btrim(p_value) between p_period->>'from_day' and p_period->>'to_day';
  end if;
  begin
    v := p_value::timestamptz;
  exception when others then
    return false;
  end;
  return v >= (p_period->>'from')::timestamptz and v < (p_period->>'to')::timestamptz;
end $$;
revoke all on function public.abo_in_period(text, jsonb) from public, anon;
grant execute on function public.abo_in_period(text, jsonb) to authenticated;

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
  -- The section shared with them, and a store section's store open to them (0140).
  if v_project is null or not public.abo_can_see_module(p_module)
     or (v_source is not null and not public.abo_can_open_store(v_project)) then
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
  -- And the dates picked above the section (0161), by the rule the page reads its rows by.
  if jsonb_typeof(p_scope->'period') = 'object' and coalesce(p_scope->'period'->>'field', '') <> '' then
    delete from abo_stat_rows t where not public.abo_in_period(t.rec ->> (p_scope->'period'->>'field'), p_scope->'period');
  end if;

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


NOTIFY pgrst, 'reload schema';
