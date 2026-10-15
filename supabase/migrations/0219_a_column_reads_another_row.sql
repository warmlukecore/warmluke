-- Migration 0219: a column reads another row (docs/ai-builder/engine.md)
--
-- A worked-out column could read only its own row. A value two sections
-- share — each printed design's blank stock, a blank's designs on it —
-- was copied across by a rule, and the rule is what broke: it missed a
-- change, read 500 of 2,058 rows, or never ran (Parent Stock, 11 Oct).
--
--   lookup(link, field, section)        a field of the row a link points at
--   rollup(section, via, how, field)    the rows of a section whose link
--                                       points here: count, sum, min, max, avg
--
-- Both are read each time, never stored, so they cannot fall out of step.
-- The browser works them out the same way (src/lib/expr.ts); here they
-- are for the stat cards, which count every row on the server.
--
-- abo_eval is 0162's with the two operators added; abo_section_stats is
-- 0194's with each row of the owner's own carrying its id, which a
-- rollup's rows point at. A lookup or a rollup reads only within the app
-- the row is in, and only a section the person asking may see.

/** Whether a section is in the same app as the row being worked out, and theirs to see. */
create or replace function public.abo_same_app(p_ctx jsonb, p_module text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1
      from public.modules a
      join public.modules b on b.project_id = a.project_id
     where a.id = (p_ctx->>'module_id')::uuid
       and b.id = p_module::uuid
  ) and (auth.uid() is null or public.abo_can_see_module(p_module::uuid));
exception when others then
  return false;
end $$;
revoke all on function public.abo_same_app(jsonb, text) from public, anon;
grant execute on function public.abo_same_app(jsonb, text) to authenticated;

-- ── The expression engine, with lookup and rollup ───────────
CREATE OR REPLACE FUNCTION public.abo_eval(node jsonb, rec jsonb, prev jsonb, tgt jsonb, ctx jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  op text; args jsonb; n int; a jsonb; b jsonb; acc numeric; i int; s text;
  cnt int; other record; same boolean; fname text; arg jsonb;
  total numeric; first int;
  v_table text; v_field text; v_view text; v_store uuid; v_sql text; v_out jsonb; k text;
  v_mod text;
begin
  if node is null then return 'null'::jsonb; end if;
  if jsonb_typeof(node) <> 'object' then return node; end if;

  if node ? 'const'  then return node->'const'; end if;
  if node ? 'field'  then return coalesce(rec  -> (node->>'field'),  'null'::jsonb); end if;
  if node ? 'was'    then return coalesce(prev -> (node->>'was'),    'null'::jsonb); end if;
  if node ? 'target' then return coalesce(tgt  -> (node->>'target'), 'null'::jsonb); end if;

  op   := node->>'op';
  args := coalesce(node->'args', '[]'::jsonb);
  n    := jsonb_array_length(args);

  if op = 'today' then return to_jsonb(public.abo_today()); end if;
  if op = 'now'   then return to_jsonb(to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')); end if;

  if op = 'if' then
    if public.abo_bool(public.abo_eval(args->0, rec, prev, tgt, ctx)) then
      return public.abo_eval(args->1, rec, prev, tgt, ctx);
    end if;
    if n > 2 then return public.abo_eval(args->2, rec, prev, tgt, ctx); end if;
    return 'null'::jsonb;
  end if;

  -- count_matching and sum_matching walk the same siblings: every OTHER
  -- row of this section, kept when it shares this row's value for each
  -- field leaf and passes each operator arg (run against the sibling).
  -- sum_matching's first arg is what is added up, read from the sibling.
  if op in ('count_matching', 'sum_matching') then
    first := case when op = 'sum_matching' then 1 else 0 end;
    if ctx->>'module_id' is null or n <= first then return to_jsonb(0); end if;
    cnt := 0;
    total := 0;
    for other in
      select r.id, r.data from public.records r
      where r.module_id = (ctx->>'module_id')::uuid
        and (ctx->>'record_id' is null or r.id <> (ctx->>'record_id')::uuid)
    loop
      same := true;

      -- Field leaves: the sibling must share this row's value.
      for i in first .. n - 1 loop
        arg := args->i;
        if not (arg ? 'field') then continue; end if;
        fname := arg->>'field';
        if coalesce(rec->>fname, '') = ''
           or coalesce(other.data->>fname, '') is distinct from coalesce(rec->>fname, '') then
          same := false;
          exit;
        end if;
      end loop;

      -- Operator args: a test run against the sibling itself, so
      -- { "field": ... } inside it reads the OTHER row.
      if same then
        for i in first .. n - 1 loop
          arg := args->i;
          if not (arg ? 'op') then continue; end if;
          if not public.abo_bool(public.abo_eval(arg, other.data, '{}'::jsonb, tgt, ctx)) then
            same := false;
            exit;
          end if;
        end loop;
      end if;

      if same then
        cnt := cnt + 1;
        if op = 'sum_matching' then
          total := total + public.abo_num(public.abo_eval(args->0, other.data, '{}'::jsonb, tgt, ctx));
        end if;
      end if;
    end loop;
    if op = 'sum_matching' then return to_jsonb(total); end if;
    return to_jsonb(cnt);
  end if;

  -- One field of one of this project's store rows, found by its keys.
  -- The list, the field and the keys are plain names (the validator
  -- holds a design to the store's own); the values are expressions.
  if op = 'store_value' then
    v_table := args->0->>'const';
    v_field := args->1->>'const';
    if ctx->>'module_id' is null or v_table is null or v_field is null or v_field !~ '^[a-z_]+$' or n < 4 then
      return 'null'::jsonb;
    end if;
    v_view := public.abo_store_view(v_table);
    if v_view is null then return 'null'::jsonb; end if;
    select s.id into v_store
      from public.modules m
      join public.stores s on s.project_id = m.project_id and s.status in ('connected', 'uninstalled')
     where m.id = (ctx->>'module_id')::uuid
     limit 1;
    if v_store is null then return 'null'::jsonb; end if;
    v_sql := format('select to_jsonb(v.%I) from public.%I v where v.store_id = $1', v_field, v_view);
    i := 2;
    while i + 1 < n loop
      k := args->i->>'const';
      if k is null or k !~ '^[a-z_]+$' then return 'null'::jsonb; end if;
      s := public.abo_txt(public.abo_eval(args->(i + 1), rec, prev, tgt, ctx));
      if s = '' then return 'null'::jsonb; end if;
      v_sql := v_sql || format(' and v.%I::text = %L', k, s);
      i := i + 2;
    end loop;
    begin
      execute v_sql || ' limit 1' into v_out using v_store;
    exception when undefined_column or undefined_table then
      return 'null'::jsonb;
    end;
    return coalesce(v_out, 'null'::jsonb);
  end if;

  -- A field of the row a link points at (0219): lookup(link, field,
  -- section). The section is the link's, written into the expression when
  -- it is built (apply.ts); a row of another app, of a section they may
  -- not see, or a link to nothing reads blank.
  if op = 'lookup' then
    v_field := args->1->>'const';
    v_mod   := args->2->>'const';
    s := public.abo_txt(public.abo_eval(args->0, rec, prev, tgt, ctx));
    if v_field is null or s = '' or v_mod is null or not public.abo_same_app(ctx, v_mod) then
      return 'null'::jsonb;
    end if;
    begin
      select m.source_table into v_table from public.modules m where m.id = v_mod::uuid;
      if v_table is null then
        select r.data -> v_field into v_out
          from public.records r
         where r.id = s::uuid and r.module_id = v_mod::uuid;
      else
        -- A store's row, with the owner's fields on it, as withOwnFields reads it.
        v_view := public.abo_store_view(v_table);
        select st.id into v_store
          from public.modules m
          join public.stores st on st.project_id = m.project_id and st.status in ('connected', 'uninstalled')
         where m.id = v_mod::uuid
         limit 1;
        if v_view is null or v_store is null then return 'null'::jsonb; end if;
        execute format(
          'select (coalesce(r.data, ''{}''::jsonb) || to_jsonb(v)) -> $4
             from public.%I v
             left join public.records r on r.module_id = $2 and r.store_row_id = v.id
            where v.store_id = $1 and v.id = $3
            limit 1', v_view)
          into v_out using v_store, v_mod::uuid, s::uuid, v_field;
      end if;
    exception when others then
      return 'null'::jsonb;
    end;
    return coalesce(v_out, 'null'::jsonb);
  end if;

  -- The rows of a section whose link points at this row (0219):
  -- rollup(section, via, how, field), over the owner's own rows and their
  -- fields on a store's rows alike (both are records). As expr.ts: a count
  -- or a sum of none is 0, the rest of none blank; only numbers are added.
  if op = 'rollup' then
    v_mod   := args->0->>'const';
    v_field := args->1->>'const';
    k       := args->2->>'const';
    fname   := coalesce(args->3->>'const', '');
    s := coalesce(rec->>'id', ctx->>'record_id', '');
    if v_mod is null or v_field is null or coalesce(k, '') not in ('count', 'sum', 'min', 'max', 'avg')
       or s = '' or not public.abo_same_app(ctx, v_mod) then
      return 'null'::jsonb;
    end if;
    begin
      with kids as (
        select r.data -> fname as v
          from public.records r
         where r.module_id = v_mod::uuid and r.data->>v_field = s
      ), nums as (
        select public.abo_num(v) as x from kids
         where public.abo_txt(v) ~ '^\s*-?[0-9]*\.?[0-9]+\s*$'
      )
      select case k
               when 'count' then to_jsonb((select count(*) from kids))
               when 'sum'   then to_jsonb(coalesce((select sum(x) from nums), 0))
               when 'min'   then coalesce(to_jsonb((select min(x) from nums)), 'null'::jsonb)
               when 'max'   then coalesce(to_jsonb((select max(x) from nums)), 'null'::jsonb)
               else              coalesce(to_jsonb((select avg(x) from nums)), 'null'::jsonb)
             end
        into v_out;
    exception when others then
      return 'null'::jsonb;
    end;
    return coalesce(v_out, 'null'::jsonb);
  end if;

  if op = 'and' then
    for i in 0 .. n - 1 loop
      if not public.abo_bool(public.abo_eval(args->i, rec, prev, tgt, ctx)) then
        return to_jsonb(false);
      end if;
    end loop;
    return to_jsonb(true);
  end if;

  if op = 'or' then
    for i in 0 .. n - 1 loop
      if public.abo_bool(public.abo_eval(args->i, rec, prev, tgt, ctx)) then
        return to_jsonb(true);
      end if;
    end loop;
    return to_jsonb(false);
  end if;

  if op = 'not' then
    return to_jsonb(not public.abo_bool(public.abo_eval(args->0, rec, prev, tgt, ctx)));
  end if;

  if op = 'changed' then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(jsonb_build_object('was', coalesce(args->0->>'field', '')), rec, prev, tgt, ctx);
    return to_jsonb(public.abo_txt(a) is distinct from public.abo_txt(b));
  end if;

  if op in ('is_empty', 'is_set') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    if op = 'is_empty' then return to_jsonb(public.abo_txt(a) = ''); end if;
    return to_jsonb(public.abo_txt(a) <> '');
  end if;

  if op = 'days_since' then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    s := public.abo_txt(a);
    if s = '' then return to_jsonb(0); end if;
    begin
      return to_jsonb((public.abo_today()::date - s::date)::numeric);
    exception when others then return to_jsonb(0);
    end;
  end if;

  if op = 'round' then
    return to_jsonb(round(public.abo_num(public.abo_eval(args->0, rec, prev, tgt, ctx))));
  end if;

  if op in ('=', '!=', '>', '>=', '<', '<=') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(args->1, rec, prev, tgt, ctx);
    return to_jsonb(
      case op
        when '='  then public.abo_cmp(a, b) = 0
        when '!=' then public.abo_cmp(a, b) <> 0
        when '>'  then public.abo_cmp(a, b) > 0
        when '>=' then public.abo_cmp(a, b) >= 0
        when '<'  then public.abo_cmp(a, b) < 0
        else           public.abo_cmp(a, b) <= 0
      end
    );
  end if;

  if op in ('contains', 'starts_with') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(args->1, rec, prev, tgt, ctx);
    if op = 'contains' then
      return to_jsonb(position(lower(public.abo_txt(b)) in lower(public.abo_txt(a))) > 0);
    end if;
    return to_jsonb(lower(public.abo_txt(a)) like lower(public.abo_txt(b)) || '%');
  end if;

  if op in ('+', '-', '*', '/') then
    acc := public.abo_num(public.abo_eval(args->0, rec, prev, tgt, ctx));
    for i in 1 .. n - 1 loop
      b := public.abo_eval(args->i, rec, prev, tgt, ctx);
      if op = '+' then acc := acc + public.abo_num(b);
      elsif op = '-' then acc := acc - public.abo_num(b);
      elsif op = '*' then acc := acc * public.abo_num(b);
      else
        if public.abo_num(b) = 0 then return to_jsonb(0); end if;
        acc := acc / public.abo_num(b);
      end if;
    end loop;
    return to_jsonb(acc);
  end if;

  if op = 'concat' then
    s := '';
    for i in 0 .. n - 1 loop
      s := s || public.abo_txt(public.abo_eval(args->i, rec, prev, tgt, ctx));
    end loop;
    return to_jsonb(s);
  end if;

  return 'null'::jsonb;
end;
$function$;

-- ── Stats: each row of the owner's own carries its id ───────
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
    -- Each row with its own id, which a rollup's rows point at (0219).
    insert into abo_stat_rows select r.data || jsonb_build_object('id', r.id) from public.records r where r.module_id = p_module and r.store_row_id is null;
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
