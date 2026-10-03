-- Migration 0162: a store's days are the shop's days
--
-- The database keeps UTC, and every store list wrote its dates as UTC
-- days (to_char in the views), while "today" was UTC's too, on the server
-- (current_date in abo_eval) and in the browser (lib/expr). A shop in
-- Mumbai saw an order placed at half past one in the morning dated the
-- day before, in its list, its calendar, its counters and its choice of
-- dates, every night until half past five; a shop in New York, every
-- evening from eight.
--
-- Now a store's days are the shop's: each list writes its dates in the
-- shop's zone (stores.timezone, the zone Shopify gives), and "today" for
-- days_since and today is the shop's on the server (abo.today, set once
-- by each thing that evaluates: the stat cards, a record's rules, its
-- guards, the scheduled rules) and in the browser (setTodayZone, set by
-- the app from the store). A project with no store keeps UTC.
--
--   abo_today           the day "today" means, as a caller set it, else UTC's
--   abo_shop_today      today in a project's shop's zone
--   abo_zone_ok, trg_stores_zone   a zone the database cannot read is never kept:
--                       it would stop every list of that shop, so it becomes UTC
--
-- The views are pg_get_viewdef's of 0087–0121's, with each day in the
-- shop's zone and the store joined for it; the functions are their last
-- versions (0137, 0143, 0161) with one line each. scripts/check-store-days.mjs.

-- ── A zone the database can read ────────────────────────────
create or replace function public.abo_zone_ok(p_zone text) returns boolean
language plpgsql immutable as $$
begin
  perform now() at time zone p_zone;
  return true;
exception when others then
  return false;
end $$;

create or replace function public.abo_store_zone_guard() returns trigger
language plpgsql as $$
begin
  if new.timezone is not null and not public.abo_zone_ok(new.timezone) then
    new.timezone := 'UTC';
  end if;
  return new;
end $$;
drop trigger if exists trg_stores_zone on public.stores;
create trigger trg_stores_zone before insert or update of timezone on public.stores
  for each row execute function public.abo_store_zone_guard();
update public.stores set timezone = 'UTC' where timezone is not null and not public.abo_zone_ok(timezone);

-- ── Today, the shop's ───────────────────────────────────────
create or replace function public.abo_today() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('abo.today', true), ''), to_char(current_date, 'YYYY-MM-DD'))
$$;

create or replace function public.abo_shop_today(p_project uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_zone text;
begin
  select s.timezone into v_zone
    from public.stores s
   where s.project_id = p_project and s.timezone is not null
   order by (s.status = 'connected') desc
   limit 1;
  return to_char(now() at time zone coalesce(v_zone, 'UTC'), 'YYYY-MM-DD');
exception when others then
  return to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
end $$;
revoke all on function public.abo_shop_today(uuid) from public, anon, authenticated;

-- ── The expression engine: today and days_since read it ─────
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

-- ── Everything that evaluates sets it, once ─────────────────
CREATE OR REPLACE FUNCTION public.abo_section_stats(p_module uuid, p_stats jsonb, p_scope jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.run_record_automations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  auto record;
  v_source text;
  v_store  jsonb := '{}'::jsonb;
  rec_data jsonb;
  old_data jsonb;
  ctx jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  -- Today is the shop's (0162).
  perform set_config('abo.today', public.abo_shop_today(coalesce(new.project_id, (select m.project_id from public.modules m where m.id = new.module_id))), true);

  -- Beside a store row: the store's fields under the merchant's, the
  -- store's winning a shared name, as withOwnFields lays them out.
  if new.store_row_id is not null then
    select m.source_table into v_source from public.modules m where m.id = new.module_id;
    v_store := public.abo_store_row(v_source, new.store_row_id);
  end if;
  rec_data := coalesce(new.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id);
  old_data := case when TG_OP = 'UPDATE'
                   then coalesce(old.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id)
                   else '{}'::jsonb end;

  for auto in
    select * from public.automations a
    where a.enabled and a.module_id = new.module_id
    order by a.created_at, a.id
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
$function$;

CREATE OR REPLACE FUNCTION public.run_record_guards()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  auto     record;
  v_source text;
  v_store  jsonb := '{}'::jsonb;
  rec_data jsonb;
  old_data jsonb;
  ctx      jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
  v_msg    text;
  v_no     boolean;
begin
  -- Today is the shop's (0162).
  perform set_config('abo.today', public.abo_shop_today(coalesce(new.project_id, (select m.project_id from public.modules m where m.id = new.module_id))), true);
  for auto in
    select a.id, a.name, a.definition
      from public.automations a
     where a.enabled and a.module_id = new.module_id
       and a.definition->'trigger'->>'type' = 'before_save'
     order by a.created_at, a.id
  loop
    -- One save at a time past this rule, and the second judged after the
    -- first is committed: the statements below take their snapshot now.
    perform pg_advisory_xact_lock(hashtextextended('abo_guard:' || auto.id::text, 0));

    if rec_data is null then
      -- The row as a rule reads it, as run_record_automations lays it out:
      -- beside a store row, the store's fields under the merchant's.
      if new.store_row_id is not null then
        select m.source_table into v_source from public.modules m where m.id = new.module_id;
        v_store := public.abo_store_row(v_source, new.store_row_id);
      end if;
      rec_data := coalesce(new.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id);
      old_data := case when TG_OP = 'UPDATE'
                       then coalesce(old.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id)
                       else '{}'::jsonb end;
    end if;

    -- A rule that cannot be judged refuses: it exists to stop something,
    -- and letting everything through when it breaks is not stopping it.
    begin
      v_no := public.abo_bool(public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb, ctx));
    exception when others then
      raise exception 'The rule "%" could not be checked, so this was not saved.', auto.name
        using errcode = 'P0001', hint = 'abo_refused', detail = sqlerrm;
    end;

    if v_no then
      v_msg := nullif(btrim(coalesce(auto.definition->'actions'->0->>'message', '')), '');
      raise exception '%', coalesce(v_msg, format('The rule "%s" refused this.', auto.name))
        using errcode = 'P0001', hint = 'abo_refused', detail = format('refused by the rule "%s"', auto.name);
    end if;
  end loop;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.run_scheduled_automations()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  auto record;
  target record;
  v_source text;
  v_view   text;
  v_project uuid;
  v_rec_id uuid;
  v_rec_data jsonb;
  ctx jsonb;
  rec_data jsonb;
begin
  for auto in
    select a.*, m.source_table, m.project_id as module_project
    from public.automations a
    join public.modules m on m.id = a.module_id
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
      -- A rule's own code is the app's to run (code_jobs, below): walked
      -- here it would only lay an empty record beside every row it matched.
      and not (coalesce(a.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb)
    order by a.created_at, a.id
  loop
    if not public.abo_schedule_due(
         auto.definition->'trigger', public.abo_rule_tz(auto.module_project), auto.scheduled_at, auto.created_at
       ) then
      continue;
    end if;
    update public.automations set scheduled_at = now() where id = auto.id;
    begin
      v_source := auto.source_table;
      v_project := auto.module_project;
      -- Today is this rule's shop's, each rule in turn (0162).
      perform set_config('abo.today', public.abo_shop_today(v_project), true);
      if v_source is null then
        -- A section of their own: its records, as always.
        for target in
          select r.id, r.project_id, r.data
          from public.records r
          where r.module_id = auto.module_id
        loop
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.id);
          rec_data := coalesce(target.data, '{}'::jsonb) || jsonb_build_object('id', target.id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            target.id, target.project_id, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      else
        -- A section over the store: every row of this project's store,
        -- with the merchant's fields where a row has them. A row the
        -- rule acts on gets its record first, so there is something to
        -- write to.
        v_view := public.abo_store_view(v_source);
        if v_view is null then continue; end if;
        for target in execute format(
          'select v.id as row_id, to_jsonb(v) - ''store_id'' as row_data, r.id as rec_id, r.data as rec_data
             from public.%I v
             join public.stores s on s.id = v.store_id
             left join public.records r on r.module_id = $2 and r.store_row_id = v.id
            where s.project_id = $1', v_view) using v_project, auto.module_id
        loop
          rec_data := coalesce(target.rec_data, '{}'::jsonb) || target.row_data
                      || jsonb_build_object('id', coalesce(target.rec_id, target.row_id));
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.rec_id, 'store_row_id', target.row_id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          v_rec_id := target.rec_id;
          if v_rec_id is null then
            insert into public.records(project_id, module_id, store_row_id, data)
            values (v_project, auto.module_id, target.row_id, '{}'::jsonb)
            returning id into v_rec_id;
            rec_data := rec_data || jsonb_build_object('id', v_rec_id);
            ctx := ctx || jsonb_build_object('record_id', v_rec_id);
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            v_rec_id, v_project, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      end if;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$function$;

-- ── Each store list's days, in the shop's zone ──────────────
create or replace view public.store_orders with (security_invoker = true) as
SELECT o.id,
    o.store_id,
    o.order_number,
    to_char((o.placed_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS placed_at,
    c.name AS customer_name,
    c.phone AS customer_phone,
    o.total,
    o.total_original,
    o.currency,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'Cancelled'::text
            ELSE o.financial_status
        END AS status,
    o.fulfilment_status,
    o.financial_status,
    o.cancelled_at,
    NULLIF(array_to_string(o.tags, ', '::text), ''::text) AS tags,
    o.gateway,
    NULLIF(array_to_string(o.discount_codes, ', '::text), ''::text) AS discount_codes,
    o.ship_city,
    o.ship_state,
    o.ship_country,
    o.subtotal,
    o.tax,
    o.shipping,
    o.discount,
    o.external_id AS shopify_id
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = o.store_id;

create or replace view public.store_order_items with (security_invoker = true) as
SELECT li.id,
    li.store_id,
    li.order_id,
    o.order_number,
    to_char((o.placed_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS placed_at,
    c.name AS customer_name,
    li.title,
    li.variant_title,
    li.sku,
    li.quantity,
    li.price,
    (li.quantity::numeric * COALESCE(li.price, 0::numeric))::numeric(12,2) AS line_total,
    o.currency,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'Cancelled'::text
            ELSE o.financial_status
        END AS status
   FROM order_line_items li
     JOIN orders o ON o.id = li.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = li.store_id;

create or replace view public.store_refunds with (security_invoker = true) as
SELECT r.id,
    r.store_id,
    r.order_id,
    o.order_number,
    to_char((COALESCE(r.refunded_at, r.created_at)) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS refunded_at,
    c.name AS customer_name,
    r.amount,
    r.quantity,
    o.currency
   FROM refunds r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = r.store_id;

create or replace view public.store_transactions with (security_invoker = true) as
SELECT t.id,
    t.store_id,
    t.order_id,
    o.order_number,
    to_char((COALESCE(t.processed_at, t.created_at)) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS processed_at,
    c.name AS customer_name,
    t.kind,
    t.status,
    t.gateway,
    t.amount,
    COALESCE(t.currency, o.currency) AS currency,
    t.test
   FROM order_transactions t
     JOIN orders o ON o.id = t.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = t.store_id;

create or replace view public.store_fulfillments with (security_invoker = true) as
SELECT f.id,
    f.store_id,
    f.order_id,
    o.order_number,
    c.name AS customer_name,
    f.carrier,
    f.tracking_number,
    f.tracking_url,
    COALESCE(f.shipment_status, f.status) AS shipment_status,
    f.status,
    to_char((f.shipped_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS shipped_at,
    to_char((f.delivered_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS delivered_at
   FROM fulfillments f
     JOIN orders o ON o.id = f.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = f.store_id;

create or replace view public.store_abandoned_checkouts with (security_invoker = true) as
SELECT id,
    store_id,
    to_char((started_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS started_at,
    COALESCE(NULLIF(name, ''::text), 'Not signed in'::text) AS customer_name,
    email,
    total,
    currency,
    item_count,
    items,
    recovery_url
   FROM abandoned_checkouts c
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = c.store_id;

create or replace view public.store_discounts with (security_invoker = true) as
SELECT id,
    store_id,
    title,
        CASE status
            WHEN 'ACTIVE'::text THEN 'Running'::text
            WHEN 'SCHEDULED'::text THEN 'Not started'::text
            WHEN 'EXPIRED'::text THEN 'Finished'::text
            ELSE initcap(COALESCE(status, ''::text))
        END AS state,
        CASE method
            WHEN 'CODE'::text THEN 'Code'::text
            WHEN 'AUTOMATIC'::text THEN 'Automatic'::text
            ELSE method
        END AS method,
    NULLIF(array_to_string(codes, ', '::text), ''::text) AS codes,
        CASE
            WHEN percent_off IS NOT NULL THEN TRIM(TRAILING '.'::text FROM TRIM(TRAILING '0'::text FROM to_char(percent_off, 'FM990.00'::text))) || '% off'::text
            WHEN amount_off IS NOT NULL THEN concat_ws(' '::text, COALESCE(currency, ''::text), TRIM(BOTH FROM to_char(amount_off, 'FM999999990.00'::text))) || ' off'::text
            WHEN kind = 'FREE_SHIPPING'::text THEN 'Free shipping'::text
            ELSE NULL::text
        END AS takes_off,
    summary,
    times_used,
    usage_limit,
        CASE
            WHEN usage_limit IS NOT NULL THEN GREATEST(usage_limit - COALESCE(times_used, 0), 0)
            ELSE NULL::integer
        END AS uses_left,
    once_per_customer,
    to_char((starts_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS starts_at,
    to_char((ends_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS ends_at,
    kind
   FROM discounts d
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = d.store_id;

create or replace view public.store_draft_orders with (security_invoker = true) as
SELECT d.id,
    d.store_id,
    d.name,
    to_char((d.drafted_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS drafted_at,
        CASE d.status
            WHEN 'OPEN'::text THEN 'Open'::text
            WHEN 'INVOICE_SENT'::text THEN 'Invoice sent'::text
            WHEN 'COMPLETED'::text THEN 'Became an order'::text
            ELSE initcap(COALESCE(d.status, 'Open'::text))
        END AS state,
    COALESCE(NULLIF(d.name_on_draft, ''::text), c.name, NULLIF(d.email, ''::text), 'No customer'::text) AS customer_name,
    d.email,
    d.total,
    d.subtotal,
    d.tax,
    d.shipping,
    d.currency,
    NULLIF(array_to_string(d.tags, ', '::text), ''::text) AS tags,
    o.order_number AS became_order,
    d.invoice_url,
    ( SELECT count(*) AS count
           FROM draft_order_line_items li
          WHERE li.draft_order_id = d.id) AS items,
    d.completed_at
   FROM draft_orders d
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN orders o ON o.id = d.order_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = d.store_id;

create or replace view public.store_payouts with (security_invoker = true) as
SELECT id,
    store_id,
    to_char((issued_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS issued_at,
        CASE status
            WHEN 'PAID'::text THEN 'In the bank'::text
            WHEN 'SCHEDULED'::text THEN 'On its way'::text
            WHEN 'FAILED'::text THEN 'Failed'::text
            WHEN 'CANCELED'::text THEN 'Cancelled'::text
            ELSE initcap(COALESCE(status, ''::text))
        END AS state,
        CASE kind
            WHEN 'DEPOSIT'::text THEN 'Paid out'::text
            WHEN 'WITHDRAWAL'::text THEN 'Taken back'::text
            ELSE kind
        END AS kind,
    net,
    currency,
    charges_gross,
    refunds_gross,
    COALESCE(charges_fee, 0::numeric) + COALESCE(refunds_fee, 0::numeric) + COALESCE(adjustments_fee, 0::numeric) + COALESCE(reserved_fee, 0::numeric) + COALESCE(retried_fee, 0::numeric) + COALESCE(advance_fee, 0::numeric) AS fees,
    adjustments_gross
   FROM payouts p
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = p.store_id;

create or replace view public.store_returns with (security_invoker = true) as
SELECT r.id,
    r.store_id,
    r.name,
    o.order_number,
    c.name AS customer_name,
        CASE r.status
            WHEN 'REQUESTED'::text THEN 'Asked for'::text
            WHEN 'OPEN'::text THEN 'Agreed, not back yet'::text
            WHEN 'CLOSED'::text THEN 'Done'::text
            WHEN 'DECLINED'::text THEN 'Refused'::text
            WHEN 'CANCELED'::text THEN 'Cancelled'::text
            ELSE initcap(COALESCE(r.status, ''::text))
        END AS state,
    r.quantity,
    ( SELECT COALESCE(sum(li.refunded_quantity), 0::bigint) AS "coalesce"
           FROM return_line_items li
          WHERE li.return_id = r.id) AS refunded_quantity,
    ( SELECT NULLIF(string_agg(DISTINCT li.reason, ', '::text), ''::text) AS "nullif"
           FROM return_line_items li
          WHERE li.return_id = r.id) AS reasons,
    ( SELECT NULLIF(string_agg(li.title, ', '::text ORDER BY li.title), ''::text) AS "nullif"
           FROM return_line_items li
          WHERE li.return_id = r.id) AS items,
    to_char((r.requested_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS requested_at,
        CASE
            WHEN (r.status = ANY (ARRAY['REQUESTED'::text, 'OPEN'::text])) AND r.requested_at IS NOT NULL THEN (now() AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text))::date - (r.requested_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text))::date
            ELSE NULL::integer
        END AS days_open,
    to_char((r.closed_at) AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text), 'YYYY-MM-DD'::text) AS closed_at
   FROM returns r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store, s.timezone AS zone FROM stores s) zone_st ON zone_st.zone_store = r.store_id;

NOTIFY pgrst, 'reload schema';
