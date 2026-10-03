-- Migration 0167: a store list, a page at a time, from the server
--
-- A section over the store read its first 200 rows, "Load more" added
-- 200 to a cap of 500 and then did nothing, and search, filters and
-- sorting worked on whatever had been loaded: on a store of 2,487
-- orders, every order past the newest 500 could not be found or
-- reached. Now the table asks for one page of the whole list, the way
-- the counters above it already count the whole list (0087):
--
--   - the store's columns are matched, sorted and searched in SQL on
--     the list itself, so the indexes it has are used: the first page of
--     a million orders is the fifty newest, read from idx_orders_placed;
--   - the merchant's own fields beside a row (0128) are joined only when
--     a filter, a sort or the search needs them;
--   - the dates picked (0161) on an order's day become a range on the
--     moment itself (placed_ts, 0166), on the same index;
--   - one round trip gives the page, how many rows match in all, and,
--     when asked, the values each filter can offer from the whole list.
--
-- Who may read it is the counters' rule: the section shared with them,
-- and its store open to them (0140, 0145). Nothing here writes.
--
-- ponytail: the total is an exact count and the page an OFFSET; both
-- read every matching row before it. Under a second up to a million
-- or so; past that, count "about" from the planner and page by the
-- last row's key. The %search% is a scan of the store's rows: add
-- trigram indexes on the searched columns when a store is that big.

create or replace function public.abo_store_page(p_module uuid, p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_project uuid;
  v_source  text;
  v_store   uuid;
  v_view    text;
  v_cols    text[];
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
  select array_agg(a.attname::text) into v_cols
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
      v_where := v_where || format(' and public.abo_stat_matches(to_jsonb(v.%I), %L)', f.key, f.value);
    else
      v_own := true;
      v_where := v_where || format(' and public.abo_stat_matches(r.data -> %L, %L)', f.key, f.value);
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
  -- value wins a name the two share, as withOwnFields does.
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

NOTIFY pgrst, 'reload schema';
