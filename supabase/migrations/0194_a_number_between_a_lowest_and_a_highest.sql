-- Migration 0194: a number or an amount, between a lowest and a highest
--
-- A filter offered one value of its column at a time, so a price or a
-- total had no filter at all: a dropdown of every price is no choice,
-- and their own AI told a merchant a Min / Max price filter could not be
-- built (Tanish, 6 Oct). A filter over a number, an amount or a percent
-- is now a lowest and a highest, either left open (src/lib/filters.ts
-- filterKind), asked of the server beside the filters and the ticks:
-- p_query.ranges on a store list's page, p_scope.ranges on the cards,
-- each field to { "min": N, "max": N }. A blank or a word is in no
-- range, never 0, the same here as in the browser (lib/filters inRange).
--
-- abo_store_page is 0171's and abo_section_stats 0162's (read from the
-- database, not the file: 0162 added the shop's today), each with the
-- one step added.

create or replace function public.abo_in_range(p_value jsonb, p_range jsonb) returns boolean
language plpgsql immutable as $$
declare
  n numeric;
  t text;
begin
  if jsonb_typeof(p_value) = 'number' then
    n := (p_value #>> '{}')::numeric;
  elsif jsonb_typeof(p_value) = 'string' then
    -- Money however it was typed: "Rs. 1,299", "₹ 1,299", "1299".
    t := regexp_replace(regexp_replace(btrim(p_value #>> '{}'), '^(rs\.?|inr)\s*', '', 'i'), '[,\s₹$€£%]', '', 'g');
    if t !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return false; end if;
    n := t::numeric;
  else
    return false;
  end if;
  return (coalesce(jsonb_typeof(p_range->'min'), '') <> 'number' or n >= (p_range->>'min')::numeric)
     and (coalesce(jsonb_typeof(p_range->'max'), '') <> 'number' or n <= (p_range->>'max')::numeric);
end $$;
revoke all on function public.abo_in_range(jsonb, jsonb) from public, anon;
grant execute on function public.abo_in_range(jsonb, jsonb) to authenticated;

create or replace function public.abo_store_page(p_module uuid, p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_project uuid;
  v_source  text;
  v_store   uuid;
  v_view    text;
  v_cols    text[];
  v_nums    text[];
  v_where   text := 'v.store_id = $1';
  v_join    text := '';
  v_own     boolean := false;
  v_order   text := '';
  v_or      text[] := '{}';
  v_search  text;
  v_digits  text;
  v_offset  int := greatest(coalesce((p_query->>'offset')::int, 0), 0);
  v_limit   int := least(greatest(coalesce((p_query->>'limit')::int, 50), 1), 200);
  v_rows    jsonb := '[]'::jsonb;
  v_total   bigint;
  v_facets  jsonb := '{}'::jsonb;
  v_vals    jsonb;
  v_period  jsonb;
  f         record;
  fld       text;
  rec       record;
  v_dir     text;
  v_sort    jsonb;
  v_ids     uuid[];
  v_ok      constant text := '^[a-z_][a-z0-9_]*$';
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select m.project_id, m.source_table into v_project, v_source from public.modules m where m.id = p_module;
  if v_project is null or v_source is null or not public.abo_is_store_table(v_source)
     or not public.abo_can_see_module(p_module) or not public.abo_can_open_store(v_project) then
    raise exception 'No such section on this account.' using errcode = '42501';
  end if;
  -- A store taken off Shopify still shows what it had, as the app reads it.
  select s.id into v_store from public.stores s
   where s.project_id = v_project and s.status in ('connected', 'uninstalled')
   order by (s.status = 'connected') desc limit 1;
  if v_store is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'facets', '{}'::jsonb);
  end if;
  -- One slow page must not hold a connection: past ten seconds it stops.
  perform set_config('statement_timeout', '10000', true);

  v_view := public.abo_store_view(v_source);
  select array_agg(a.attname::text),
         coalesce(array_agg(a.attname::text) filter (
           where a.atttypid = any (array['numeric', 'int2', 'int4', 'int8', 'float4', 'float8']::regtype[])), '{}')
    into v_cols, v_nums
    from pg_attribute a
   where a.attrelid = ('public.' || v_view)::regclass and a.attnum > 0 and not a.attisdropped;

  -- The search box: each field asked for, the store's or the merchant's,
  -- and a phone however it was typed (0166).
  v_search := nullif(btrim(coalesce(p_query->>'search', '')), '');
  if v_search is not null then
    for fld in select value from jsonb_array_elements_text(coalesce(p_query->'search_fields', '[]'::jsonb)) loop
      continue when fld !~ v_ok;
      if fld = any (v_cols) then
        v_or := v_or || format('v.%I::text ilike $3', fld);
      else
        v_own := true;
        v_or := v_or || format('(r.data->>%L) ilike $3', fld);
      end if;
    end loop;
    v_digits := regexp_replace(v_search, '\D', '', 'g');
    if length(v_digits) >= 6 and 'phone_digits' = any (v_cols) then
      v_or := v_or || 'v.phone_digits like $4'::text;
    end if;
    if cardinality(v_or) > 0 then
      v_where := v_where || ' and (' || array_to_string(v_or, ' or ') || ')';
    end if;
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := '%' || coalesce(v_digits, '') || '%';
  end if;

  -- Each filter, by the counters' own rule (abo_stat_matches).
  for f in select key, value from jsonb_each_text(coalesce(p_query->'filters', '{}'::jsonb)) loop
    continue when f.key !~ v_ok or btrim(coalesce(f.value, '')) = '';
    if f.key = any (v_cols) then
      -- abo_stat_matches' rule, written out: the whole value, or one of a
      -- list's parts. A function called once a row cost half a second on
      -- 20,000 orders; this is the same test in the query itself.
      v_where := v_where || format(
        ' and (lower(btrim(v.%1$I::text)) = %2$L or (v.%1$I::text like ''%%,%%'' and %2$L = any (
              select lower(btrim(p)) from unnest(string_to_array(v.%1$I::text, '','')) p)))',
        f.key, lower(btrim(f.value)));
    else
      v_own := true;
      v_where := v_where || format(' and public.abo_stat_matches(r.data -> %L, %L)', f.key, f.value);
    end if;
  end loop;

  -- A yes/no field asked as a tick: ticked, or every row that is not,
  -- blank and false alike. As text it matched "Yes" against true and
  -- "No" against nothing (an RTO filter, 3 Oct).
  for f in select key, value from jsonb_each(coalesce(p_query->'flags', '{}'::jsonb)) loop
    continue when f.key !~ v_ok or jsonb_typeof(f.value) <> 'boolean';
    if f.key = any (v_cols) then
      v_where := v_where || format(' and %s(coalesce(lower(v.%I::text), '''') in (''true'', ''t'', ''yes'', ''1''))',
                                   case when f.value = 'true'::jsonb then '' else 'not ' end, f.key);
    else
      v_own := true;
      v_where := v_where || format(' and %s(coalesce(lower(r.data->>%L), '''') in (''true'', ''yes'', ''1''))',
                                   case when f.value = 'true'::jsonb then '' else 'not ' end, f.key);
    end if;
  end loop;

  -- A number or an amount between a lowest and a highest (0194), either
  -- end left open: a price filter asked for as Min and Max. The store's
  -- own number is compared as it stands; a merchant's field, or a number
  -- the view holds as words, by abo_in_range, where a blank is in none.
  for f in select key, value from jsonb_each(coalesce(p_query->'ranges', '{}'::jsonb)) loop
    continue when f.key !~ v_ok or jsonb_typeof(f.value) <> 'object';
    if f.key = any (v_nums) then
      if jsonb_typeof(f.value->'min') = 'number' then
        v_where := v_where || format(' and v.%I >= %L::numeric', f.key, f.value->>'min');
      end if;
      if jsonb_typeof(f.value->'max') = 'number' then
        v_where := v_where || format(' and v.%I <= %L::numeric', f.key, f.value->>'max');
      end if;
    elsif f.key = any (v_cols) then
      v_where := v_where || format(' and public.abo_in_range(to_jsonb(v.%I), %L::jsonb)', f.key, f.value);
    else
      v_own := true;
      v_where := v_where || format(' and public.abo_in_range(r.data -> %L, %L::jsonb)', f.key, f.value);
    end if;
  end loop;

  -- The dates picked. An order's day is a range on the moment it was
  -- placed, on the orders index; any other date by the counters' rule.
  v_period := p_query->'period';
  if jsonb_typeof(v_period) = 'object' and coalesce(v_period->>'field', '') ~ v_ok then
    fld := v_period->>'field';
    if fld = 'placed_at' and 'placed_ts' = any (v_cols) and v_period ? 'from' and v_period ? 'to' then
      v_where := v_where || format(' and v.placed_ts >= %L::timestamptz and v.placed_ts < %L::timestamptz',
                                   v_period->>'from', v_period->>'to');
    elsif fld = any (v_cols) then
      v_where := v_where || format(' and public.abo_in_period(v.%I::text, %L::jsonb)', fld, v_period);
    else
      v_own := true;
      v_where := v_where || format(' and public.abo_in_period(r.data->>%L, %L::jsonb)', fld, v_period);
    end if;
  end if;

  -- The order: the column they sorted by, then the list's own, then the
  -- row itself, so a page is the same page each time it is read.
  v_sort := p_query->'sort';
  if jsonb_typeof(v_sort) = 'object' and coalesce(v_sort->>'field', '') ~ v_ok then
    fld := v_sort->>'field';
    v_dir := case when v_sort->>'dir' = 'asc' then 'asc' else 'desc' end;
    if fld = any (v_cols) then
      v_order := format('v.%I %s nulls last, ', fld, v_dir);
    else
      v_own := true;
      v_order := case when v_sort->>'kind' = 'number'
                      then format('public.abo_stat_num(r.data -> %L) %s nulls last, ', fld, v_dir)
                      else format('(r.data->>%L) %s nulls last, ', fld, v_dir) end;
    end if;
  end if;
  v_sort := p_query->'order';
  if jsonb_typeof(v_sort) = 'object' and coalesce(v_sort->>'field', '') = any (v_cols) then
    v_order := v_order || format('v.%I %s nulls last, ', v_sort->>'field',
                                 case when v_sort->>'dir' = 'asc' then 'asc' else 'desc' end);
  end if;
  v_order := v_order || case when 'id' = any (v_cols) then 'v.id' else '1' end;

  if v_own then
    v_join := case when 'id' = any (v_cols)
                   then ' left join public.records r on r.module_id = $2 and r.store_row_id = v.id'
                   else ' left join public.records r on r.module_id = $2 and r.store_row_id::text = to_jsonb(v)->>''id''' end;
  end if;

  execute format('select count(*) from public.%I v%s where %s', v_view, v_join, v_where)
    into v_total using v_store, p_module, v_search, v_digits;

  -- The page, each row with the merchant's fields under it: the store's
  -- value wins a name the two share, as withOwnFields does. Its ids are
  -- found first and only those rows built: built in the one query, a row
  -- was made for every row skipped on the way to a later page.
  if 'id' = any (v_cols) then
    execute format('select array(select v.id from public.%I v%s where %s order by %s limit %s offset %s)',
                   v_view, v_join, v_where, v_order, v_limit, v_offset)
      into v_ids using v_store, p_module, v_search, v_digits;
    for rec in execute format(
      'select jsonb_build_object(''id'', v.id, ''data'', coalesce(o.data, ''{}''::jsonb) || (to_jsonb(v) - ''store_id'')) as j
         from unnest($1) with ordinality as u(id, n)
         join public.%I v on v.id = u.id
         left join public.records o on o.module_id = $2 and o.store_row_id = v.id
        order by u.n', v_view)
      using v_ids, p_module
    loop
      v_rows := v_rows || jsonb_build_array(rec.j);
    end loop;
  else
  for rec in execute format(
    'select jsonb_build_object(''id'', %s, ''data'', coalesce(o.data, ''{}''::jsonb) || (to_jsonb(v) - ''store_id'')) as j
       from public.%I v%s
       left join public.records o on o.module_id = $2 and %s
      where %s
      order by %s
      limit %s offset %s',
    case when 'id' = any (v_cols) then 'v.id' else 'md5(to_jsonb(v)::text)' end,
    v_view, v_join,
    case when 'id' = any (v_cols) then 'o.store_row_id = v.id' else 'false' end,
    v_where, v_order, v_limit, v_offset)
    using v_store, p_module, v_search, v_digits
  loop
    v_rows := v_rows || jsonb_build_array(rec.j);
  end loop;
  end if;

  -- What each filter can offer, from the whole list: the fifty most common.
  for fld in select value from jsonb_array_elements_text(coalesce(p_query->'facets', '[]'::jsonb)) loop
    continue when fld !~ v_ok;
    if fld = any (v_cols) then
      execute format(
        'select coalesce(jsonb_agg(x order by n desc, x), ''[]''::jsonb)
           from (select v.%I::text as x, count(*) as n from public.%I v
                  where v.store_id = $1 and nullif(btrim(v.%I::text), '''') is not null
                  group by 1 order by 2 desc limit 50) q', fld, v_view, fld)
        into v_vals using v_store;
    else
      execute format(
        'select coalesce(jsonb_agg(x order by n desc, x), ''[]''::jsonb)
           from (select r.data->>%L as x, count(*) as n from public.records r
                  where r.module_id = $1 and r.store_row_id is not null and nullif(btrim(r.data->>%L), '''') is not null
                  group by 1 order by 2 desc limit 50) q', fld, fld)
        into v_vals using p_module;
    end if;
    v_facets := v_facets || jsonb_build_object(fld, v_vals);
  end loop;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'facets', v_facets);
end $$;
revoke all on function public.abo_store_page(uuid, jsonb) from public, anon;
grant execute on function public.abo_store_page(uuid, jsonb) to authenticated;


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

  -- Today is the shop's, for a days_since in a stat's where (0162).
  perform set_config('abo.today', public.abo_shop_today(v_project), true);
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
  -- A number or an amount between a lowest and a highest (0194), by the
  -- page's own rule.
  for f in select key, value from jsonb_each(coalesce(p_scope->'ranges', '{}'::jsonb)) where jsonb_typeof(value) = 'object' loop
    delete from abo_stat_rows t where not public.abo_in_range(t.rec -> f.key, f.value);
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
revoke all on function public.abo_section_stats(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.abo_section_stats(uuid, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
